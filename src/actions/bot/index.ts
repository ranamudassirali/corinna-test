'use server'

import { client } from '@/lib/prisma'
import { extractEmailsFromString, extractURLfromString } from '@/lib/utils'
import { onRealTimeChat } from '../conversation'
import { clerkClient } from '@clerk/nextjs'
import { onMailer } from '../mailer'
import OpenAi from 'openai'

const openai = new OpenAi({
  apiKey: process.env.OPEN_AI_KEY,
})

export const onStoreConversations = async (
  id: string,
  message: string,
  role: 'assistant' | 'user'
) => {
  await client.chatRoom.update({
    where: {
      id,
    },
    data: {
      message: {
        create: {
          message,
          role,
        },
      },
    },
  })
}

export const onGetCurrentChatBot = async (id: string) => {
  try {
    const chatbot = await client.domain.findUnique({
      where: {
        id,
      },
      select: {
        helpdesk: true,
        name: true,
        chatBot: {
          select: {
            id: true,
            welcomeMessage: true,
            icon: true,
            textColor: true,
            background: true,
            helpdesk: true,
          },
        },
      },
    })

    if (chatbot) {
      return chatbot
    }
  } catch (error) {
    console.log(error)
  }
}

export const onAiChatBotAssistant = async (
  id: string,
  chat: { role: 'assistant' | 'user'; content: string }[],
  author: 'user',
  message: string
) => {
  let customerEmail: string | undefined

  try {
    const chatBotDomain = await client.domain.findUnique({
      where: {
        id,
      },
      select: {
        name: true,
        filterQuestions: {
          where: {
            answered: null,
          },
          select: {
            question: true,
          },
        },
      },
    })

    if (chatBotDomain) {
      // 1. EMAIL DISCOVERY (Scan current message + History)
      const currentEmail = extractEmailsFromString(message)
      if (currentEmail) {
        customerEmail = currentEmail[0]
      } else {
        const historyEmail = chat.find((c) => extractEmailsFromString(c.content))
        if (historyEmail) {
          customerEmail = extractEmailsFromString(historyEmail.content)![0]
        }
      }

      if (customerEmail) {
        const checkCustomer = await client.domain.findUnique({
          where: {
            id,
          },
          select: {
            User: {
              select: {
                clerkId: true,
              },
            },
            name: true,
            customer: {
              where: {
                email: {
                  startsWith: customerEmail,
                },
              },
              select: {
                id: true,
                email: true,
                questions: true,
                chatRoom: {
                  select: {
                    id: true,
                    live: true,
                    mailed: true,
                  },
                },
              },
            },
          },
        })

        // New Customer Logic
        if (checkCustomer && !checkCustomer.customer.length) {
          const newCustomer = await client.domain.update({
            where: {
              id,
            },
            data: {
              customer: {
                create: {
                  email: customerEmail,
                  questions: {
                    create: chatBotDomain.filterQuestions,
                  },
                  chatRoom: {
                    create: {},
                  },
                },
              },
            },
          })
          if (newCustomer) {
            const response = {
              role: 'assistant',
              content: `Welcome aboard ${
                customerEmail.split('@')[0]
              }! I'm glad to connect with you. Is there anything you need help with?`,
            }
            return { response }
          }
        }

        // Live Chat Logic
        if (checkCustomer && checkCustomer.customer[0].chatRoom[0].live) {
          await onStoreConversations(
            checkCustomer?.customer[0].chatRoom[0].id!,
            message,
            author
          )
          
          onRealTimeChat(
            checkCustomer.customer[0].chatRoom[0].id,
            message,
            'user',
            author
          )

          if (!checkCustomer.customer[0].chatRoom[0].mailed) {
            const user = await clerkClient.users.getUser(
              checkCustomer.User?.clerkId!
            )
            onMailer(user.emailAddresses[0].emailAddress)
            const mailed = await client.chatRoom.update({
              where: {
                id: checkCustomer.customer[0].chatRoom[0].id,
              },
              data: {
                mailed: true,
              },
            })
            if (mailed) {
              return {
                live: true,
                chatRoom: checkCustomer.customer[0].chatRoom[0].id,
              }
            }
          }
          return {
            live: true,
            chatRoom: checkCustomer.customer[0].chatRoom[0].id,
          }
        }

        await onStoreConversations(
          checkCustomer?.customer[0].chatRoom[0].id!,
          message,
          author
        )

        // 2. AGGRESSIVE PROMPT LOGIC
        const chatCompletion = await openai.chat.completions.create({
          messages: [
            {
              role: 'system',
              content: `
              You are a sales representative for ${chatBotDomain.name}.
              
              ### CRITICAL RULES (READ FIRST)
              Check the user's message for these conditions BEFORE answering:

              1. **HANDOFF / AGGRESSION**: 
                 - If the user uses profanity (e.g., "fuck", "shit", "stupid").
                 - If the user is hostile or aggressive.
                 - If the user says "I don't want to talk to you", "stop", "no bot", or asks for a "human" or "agent".
                 -> YOU MUST RESPONSE WITH ONLY: "(realtime)"
                 -> Do not apologize. Do not say goodbye. Just return the keyword.

              2. **LINKS (High Priority)**: 
                 - If the user asks to book/schedule/meet -> Reply: "Here is the appointment link: ${process.env.NEXT_PUBLIC_DOMAIN}/portal/${id}/appointment/${checkCustomer?.customer[0].id}"
                 - If the user asks to buy/purchase/pay -> Reply: "Here is the payment link: ${process.env.NEXT_PUBLIC_DOMAIN}/portal/${id}/payment/${checkCustomer?.customer[0].id}"
                 - Do NOT ask more questions if they want a link.

              3. **SALES CONVERSATION**:
                 - If rules 1 and 2 don't apply, ask these questions one by one: [${chatBotDomain.filterQuestions
                   .map((questions) => questions.question)
                   .join(', ')}].
                 - When asking a filter question, end the sentence with "(complete)".

              4. **UNKNOWN**:
                 - If the user asks a technical question you don't know, reply: "(realtime)"
              `,
            },
            ...chat,
            {
              role: 'user',
              content: message,
            },
          ],
          model: 'gpt-3.5-turbo',
          temperature: 0, // Zero temperature prevents "polite" deviations
        })

        // Handling (realtime)
        if (chatCompletion.choices[0].message.content?.includes('(realtime)')) {
          const realtime = await client.chatRoom.update({
            where: {
              id: checkCustomer?.customer[0].chatRoom[0].id,
            },
            data: {
              live: true,
            },
          })
          if (realtime) {
            // Strip the keyword but keep any polite text if it exists (though prompt says don't add any)
            const cleanContent = chatCompletion.choices[0].message.content.replace(
                '(realtime)',
                ''
              ).trim()
            
            // If the bot returned ONLY "(realtime)", we can inject a default system message
            const finalContent = cleanContent || "I will connect you with a human agent now."

            const response = {
              role: 'assistant',
              content: finalContent,
            }

            await onStoreConversations(
              checkCustomer?.customer[0].chatRoom[0].id!,
              response.content,
              'assistant'
            )
            return { response }
          }
        }

        // Handling (complete) for filter questions
        if (chat[chat.length - 1].content.includes('(complete)')) {
          const firstUnansweredQuestion =
            await client.customerResponses.findFirst({
              where: {
                customerId: checkCustomer?.customer[0].id,
                answered: null,
              },
              select: {
                id: true,
              },
              orderBy: {
                question: 'asc',
              },
            })
          if (firstUnansweredQuestion) {
            await client.customerResponses.update({
              where: {
                id: firstUnansweredQuestion.id,
              },
              data: {
                answered: message,
              },
            })
          }
        }

        // Handling Link Extraction
        if (chatCompletion) {
          const generatedLink = extractURLfromString(
            chatCompletion.choices[0].message.content as string
          )

          if (generatedLink) {
            const link = generatedLink[0]
            const sanitizedLink = link.replace(/[)\]\.,]+$/, '')
            const response = {
              role: 'assistant',
              content: `Great! You can follow the link to proceed:`,
              link: sanitizedLink,
            }

            await onStoreConversations(
              checkCustomer?.customer[0].chatRoom[0].id!,
              `${response.content} ${response.link}`,
              'assistant'
            )

            return { response }
          }

          const response = {
            role: 'assistant',
            content: chatCompletion.choices[0].message.content,
          }

          await onStoreConversations(
            checkCustomer?.customer[0].chatRoom[0].id!,
            `${response.content}`,
            'assistant'
          )

          return { response }
        }
      }

      // No Customer Logic
      console.log('No customer')
      const chatCompletion = await openai.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: `
            You are a sales assistant.
            Goal: Get the user's email address.
            
            GUARDRAILS:
            - If the user is aggressive, swears, or says "no" -> Reply with "(realtime)".
            - If the user asks for a human -> Reply with "(realtime)".
            
            Otherwise, politely ask for their email address.
            `,
          },
          ...chat,
          {
            role: 'user',
            content: message,
          },
        ],
        model: 'gpt-3.5-turbo',
      })
      
      // Handle Realtime in "No Customer" mode as well
      if (chatCompletion.choices[0].message.content?.includes('(realtime)')) {
          return {
             response: {
                 role: 'assistant',
                 content: 'I will connect you with a human support agent.'
             }
             // Note: You can't toggle 'live' mode easily here because we don't have a customer record yet,
             // but you can at least stop the bot from arguing.
          }
      }

      if (chatCompletion) {
        const response = {
          role: 'assistant',
          content: chatCompletion.choices[0].message.content,
        }
        return { response }
      }
    }
  } catch (error) {
    console.log(error)
  }
}
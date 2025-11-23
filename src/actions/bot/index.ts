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
      // 1. IMPROVED EMAIL DISCOVERY
      // First, check the current message
      const currentEmail = extractEmailsFromString(message)
      if (currentEmail) {
        customerEmail = currentEmail[0]
      } else {
        // If not in current message, SCAN HISTORY to remember who this is
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

        // 2. IMPROVED PROMPT LOGIC
        const chatCompletion = await openai.chat.completions.create({
          messages: [
            {
              role: 'system',
              content: `
              You are a sales representative for ${chatBotDomain.name}.
              
              ### PRIORITY INSTRUCTIONS
              1. **LINKS FIRST**: If the user asks to book an appointment, schedule a meeting, or buy a product, YOU MUST PROVIDE THE LINK IMMEDIATELY.
                 - Do NOT ask for "date", "time", or "purpose".
                 - Do NOT ask for their email again.
                 - Simply say "Here is the link:" and provide the URL.

              2. **LINKS**:
                 - Appointment Link: ${process.env.NEXT_PUBLIC_DOMAIN}/portal/${id}/appointment/${checkCustomer?.customer[0].id}
                 - Payment Link: ${process.env.NEXT_PUBLIC_DOMAIN}/portal/${id}/payment/${checkCustomer?.customer[0].id}

              3. **FILTER QUESTIONS**:
                 - If the user is NOT asking for a link, ask these questions one by one: [${chatBotDomain.filterQuestions
                   .map((questions) => questions.question)
                   .join(', ')}].
                 - When asking a filter question, end the sentence with "(complete)".

              4. **REALTIME**:
                 - If the user is angry or asks a complex technical question, reply with "(realtime)".

              5. **BEHAVIOR**:
                 - Keep responses concise.
                 - Never ask for information if the user is asking for a link.
              `,
            },
            ...chat,
            {
              role: 'user',
              content: message,
            },
          ],
          model: 'gpt-3.5-turbo',
          temperature: 0, // Set to 0 for maximum strictness
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
            const response = {
              role: 'assistant',
              content: chatCompletion.choices[0].message.content.replace(
                '(realtime)',
                ''
              ),
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

      // No Customer Logic (Only reached if email is NEVER found in history)
      console.log('No customer')
      const chatCompletion = await openai.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: `
            You are a helpful assistant.
            The user is trying to talk to us. 
            Your ONLY goal is to get their email address.
            Do not answer any questions until you have the email address.
            Simply ask: "To assist you, may I have your email address?"
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
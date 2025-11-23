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
      // 1. EMAIL DISCOVERY
      const currentEmail = extractEmailsFromString(message)
      if (currentEmail) {
        customerEmail = currentEmail[0]
      } else {
        const historyEmail = chat.find((c) => extractEmailsFromString(c.content))
        if (historyEmail) {
          customerEmail = extractEmailsFromString(historyEmail.content)![0]
        }
      }

      // --- EXISTING CUSTOMER FLOW ---
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

        // PROMPT FOR EXISTING CUSTOMERS
        const chatCompletion = await openai.chat.completions.create({
          messages: [
            {
              role: 'system',
              content: `
              You are a sales representative for ${chatBotDomain.name}.
              
              ### CRITICAL INSTRUCTIONS
              1. **REALTIME HANDOFF**: 
                 - If the user is aggressive, rude, or asks for a human -> RESPONSE: "(realtime)"
                 - Do not apologize. Just return the keyword.

              2. **LINKS FIRST**: 
                 - Appointment? -> "Here is the appointment link: ${process.env.NEXT_PUBLIC_DOMAIN}/portal/${id}/appointment/${checkCustomer?.customer[0].id}"
                 - Payment? -> "Here is the payment link: ${process.env.NEXT_PUBLIC_DOMAIN}/portal/${id}/payment/${checkCustomer?.customer[0].id}"

              3. **SALES**:
                 - Otherwise, ask these questions one by one: [${chatBotDomain.filterQuestions
                   .map((questions) => questions.question)
                   .join(', ')}].
                 - End question with "(complete)".
              `,
            },
            ...chat,
            {
              role: 'user',
              content: message,
            },
          ],
          model: 'gpt-3.5-turbo',
          temperature: 0,
        })

        // Handle (realtime) trigger
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
              content: "I have notified a human agent. They will join this chat shortly.", // Polite confirmation
            }
            await onStoreConversations(
              checkCustomer?.customer[0].chatRoom[0].id!,
              response.content,
              'assistant'
            )
            return { response }
          }
        }

        // Handle (complete) logic
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

        // Link Response
        if (chatCompletion) {
          const generatedLink = extractURLfromString(
            chatCompletion.choices[0].message.content as string
          )
          if (generatedLink) {
             // ... link logic ...
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

      // --- CASE 4: NO CUSTOMER (EMAIL CAPTURE MODE) ---
      console.log('No customer')
      const chatCompletion = await openai.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: `
            You are a helpful assistant for ${chatBotDomain.name}.
            
            ### GOAL
            Your ONLY goal is to get the user's email address. You cannot do anything else until you have it.

            ### SITUATION: USER IS AGGRESSIVE OR WANTS HUMAN
            If the user is angry, rude, swears, or asks for a "human" or "agent":
            1. DO NOT return "(realtime)" yet (you cannot connect them without an email).
            2. instead, Reply: "I understand you are frustrated and want to speak to a human. Please provide your email address so I can connect you with a manager immediately."
            
            ### SITUATION: NORMAL
            Simply ask: "To assist you further, may I have your email address?"
            `,
          },
          ...chat,
          {
            role: 'user',
            content: message,
          },
        ],
        model: 'gpt-3.5-turbo',
        temperature: 0.1, 
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
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
  // MOVED INSIDE FUNCTION FOR THREAD SAFETY
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
            answered: null, // This ensures we only get unanswered questions
          },
          select: {
            question: true,
          },
        },
      },
    })

    if (chatBotDomain) {
      const extractedEmail = extractEmailsFromString(message)
      if (extractedEmail) {
        customerEmail = extractedEmail[0]
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

        // --- CASE 1: New Customer Creation ---
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
            console.log('new customer made')
            const response = {
              role: 'assistant',
              content: `Welcome aboard ${
                customerEmail.split('@')[0]
              }! I'm glad to connect with you. Is there anything you need help with?`,
            }
            return { response }
          }
        }

        // --- CASE 2: Live Chat Mode (Bypass AI) ---
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

            //update mail status to prevent spamming
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

        // --- CASE 3: AI Assistant (Existing Customer) ---
        const chatCompletion = await openai.chat.completions.create({
          messages: [
            {
              role: 'system', // CHANGED FROM ASSISTANT TO SYSTEM
              content: `
              ### ROLE
              You are a sales representative for ${chatBotDomain.name}. You are helpful, polite, and concise.

              ### OBJECTIVE
              Your goal is to gather information from the customer using specific questions, or guide them to book an appointment/make a payment.

              ### INSTRUCTIONS
              1. **Filter Questions**: You have a list of questions to ask: [${chatBotDomain.filterQuestions
                .map((questions) => questions.question)
                .join(', ')}].
                 - Ask these questions ONE by ONE.
                 - When you ask a question from this list, you MUST append the keyword "(complete)" to the end of the sentence.
                 - Do not ask the same question twice.

              2. **Appointment Logic**: If the user asks to book an appointment or consultation, simply reply with this link: ${process.env.NEXT_PUBLIC_DOMAIN}/portal/${id}/appointment/${checkCustomer?.customer[0].id}

              3. **Payment Logic**: If the user asks to buy a product or make a payment, simply reply with this link: ${process.env.NEXT_PUBLIC_DOMAIN}/portal/${id}/payment/${checkCustomer?.customer[0].id}

              4. **Guardrails**:
                 - If the user asks a question unrelated to ${chatBotDomain.name} (e.g., "Who is the president?", "What is math?"), politely refuse and steer back to the business.
                 - If the user is angry, rude, or asks a complex technical question you cannot answer, reply ONLY with the keyword "(realtime)".
                 - Keep responses short (under 3 sentences) unless explaining a product.

              ### IMPORTANT
              - Only use "(complete)" when asking a filter question.
              - Only use "(realtime)" when you need a human agent.
              `,
            },
            ...chat,
            {
              role: 'user',
              content: message,
            },
          ],
          model: 'gpt-3.5-turbo',
          temperature: 0.2, // REDUCED TEMP TO PREVENT HALLUCINATION
        })

        // ... (Rest of your logic for handling realtime/complete keywords remains valid)
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

        if (chatCompletion) {
          const generatedLink = extractURLfromString(
            chatCompletion.choices[0].message.content as string
          )

          if (generatedLink) {
            const link = generatedLink[0]
            const sanitizedLink = link.replace(/[)\]\.,]+$/, '')
            const response = {
              role: 'assistant',
              content: `Great! you can follow the link to proceed`,
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
      
      // --- CASE 4: No Customer (Email Capture Mode) ---
      console.log('No customer')
      const chatCompletion = await openai.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: `
            ### ROLE
            You are a helpful, professional sales representative for ${chatBotDomain.name}.

            ### GOAL
            Your SOLE objective is to naturally capture the user's email address.
            
            ### INSTRUCTIONS
            1. Ask the user for their email address to continue the conversation or provide assistance.
            2. Do NOT answer technical questions or provide detailed support until you have their email.
            3. If the user refuses, politely insist that you need an email to send them relevant information.
            4. Keep responses very short (1-2 sentences).
            5. Do NOT make up facts or features about the company.

            ### GUARDRAIL
            If the user is aggressive or the conversation is failing, reply with "(realtime)".
            `,
          },
          ...chat,
          {
            role: 'user',
            content: message,
          },
        ],
        model: 'gpt-3.5-turbo',
        temperature: 0.2, // Strict adherence
        max_tokens: 150,
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
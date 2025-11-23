import React from 'react'
import { cn, extractUUIDFromString, getMonthName } from '@/lib/utils'
import { Avatar, AvatarFallback, AvatarImage } from '../ui/avatar'
import { User } from 'lucide-react'
import Image from 'next/image'
import Link from 'next/link'

type Props = {
  message: {
    role: 'assistant' | 'user'
    content: string
    link?: string
  }
  createdAt?: Date
}

const Bubble = ({ message, createdAt }: Props) => {
  const d = new Date()
  const isAssistant = message.role === 'assistant'
  const image = extractUUIDFromString(message.content)

  return (
    <div
      className={cn(
        'flex gap-2 items-end',
        isAssistant ? 'self-start' : 'self-end flex-row-reverse'
      )}
    >
      {isAssistant ? (
        <Avatar className="w-5 h-5 bg-muted">
          <AvatarImage
            src="https://github.com/shadcn.png"
            alt="@shadcn"
          />
          <AvatarFallback>CN</AvatarFallback>
        </Avatar>
      ) : (
        <Avatar className="w-5 h-5 bg-orange/10 text-orange-600">
          <AvatarFallback>
            <User className="h-3 w-3" />
          </AvatarFallback>
        </Avatar>
      )}
      <div
        className={cn(
          'flex flex-col gap-3 min-w-[200px] max-w-[300px] p-4 rounded-t-md',
          isAssistant
            ? 'bg-muted rounded-r-md text-white'
            : 'bg-orange rounded-l-md text-gray-800'
        )}
      >
        {createdAt ? (
          <div
            className={cn(
              'flex gap-2 text-xs font-bold',
              isAssistant ? 'text-white/80' : 'text-gray-800'
            )}
          >
            <p>
              {createdAt.getDate()} {getMonthName(createdAt.getMonth())}
            </p>
            <p>
              {createdAt.getHours()}:{createdAt.getMinutes()}
              {createdAt.getHours() > 12 ? 'PM' : 'AM'}
            </p>
          </div>
        ) : (
          <p
            className={cn(
              'text-xs font-bold',
              isAssistant ? 'text-white/80' : 'text-gray-800'
            )}
          >
            {`${d.getHours()}:${d.getMinutes()} ${
              d.getHours() > 12 ? 'pm' : 'am'
            }`}
          </p>
        )}
        {image ? (
          <div className="relative aspect-square">
            <Image
              src={`https://ucarecdn.com/${image[0]}/`}
              fill
              alt="image"
            />
          </div>
        ) : (
          <p
            className={cn(
              'text-sm font-bold leading-relaxed',
              isAssistant ? 'text-white' : 'text-gray-800'
            )}
          >
            {message.content.replace('(complete)', ' ')}
            {message.link && (
              <Link
                className={cn(
                  'underline font-bold pl-2',
                  isAssistant ? 'text-white' : 'text-orange-800'
                )}
                href={message.link}
                target="_blank"
              >
                Your Link
              </Link>
            )}
          </p>
        )}
      </div>
    </div>
  )
}

export default Bubble

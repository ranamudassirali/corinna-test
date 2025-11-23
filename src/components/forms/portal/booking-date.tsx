import { Loader } from '@/components/loader'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Card, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { APPOINTMENT_TIME_SLOTS } from '@/constants/timeslots'
import { cn } from '@/lib/utils'
import React from 'react'
import { FieldValues, UseFormRegister } from 'react-hook-form'

type Props = {
  date: Date | undefined
  onBooking: React.Dispatch<React.SetStateAction<Date | undefined>>
  onBack(): void
  register: UseFormRegister<FieldValues>
  onSlot(slot: string): void
  currentSlot?: string
  loading: boolean
  bookings:
    | {
        date: Date
        slot: string
      }[]
    | undefined
}

const BookAppointmentDate = ({
  date,
  onBooking,
  onBack,
  register,
  onSlot,
  currentSlot,
  loading,
  bookings,
}: Props) => {
  const today = React.useMemo(() => {
    const current = new Date()
    current.setHours(0, 0, 0, 0)
    return current
  }, [])

  const normalizedBookings = React.useMemo(
    () =>
      bookings?.map((booking) => ({
        ...booking,
        date: new Date(booking.date),
      })),
    [bookings]
  )

  const selectedDateString = date ? date.toDateString() : null

  return (
    <div className="flex flex-col gap-5 justify-center">
      <div className="flex justify-center">
        <h2 className="text-4xl font-bold mb-5">Book a meeting</h2>
      </div>
      <div className="flex gap-10 flex-col sm:flex-row">
        <div className="w-[300px]">
          <h6>Discovery Call</h6>
          <CardDescription>
            During this call, we aim to explore potential avenues for
            partnership, promotional opportunities, or any other means through
            which we can contribute to the success of your company.
          </CardDescription>
        </div>
        <div>
          <Calendar
            mode="single"
            selected={date}
            onSelect={onBooking}
            className="rounded-md border"
            disabled={(day) => day < today}
          />
        </div>
        <div className="flex flex-col gap-5">
          {APPOINTMENT_TIME_SLOTS.map((slot, key) => {
            const isSlotBooked =
              !!selectedDateString &&
              normalizedBookings?.some((booking) => {
                if (booking.slot !== slot.slot) return false
                return booking.date.toDateString() === selectedDateString
              })

            const isSelected = currentSlot === slot.slot && !isSlotBooked

            return (
              <Label
                htmlFor={`slot-${key}`}
                key={key}
              >
                <Card
                  onClick={() => {
                    if (!isSlotBooked) {
                      onSlot(slot.slot)
                    }
                  }}
                  className={cn(
                    'px-10 py-4 text-white font-semibold border-2 border-transparent bg-orange transition duration-150 ease-in-out',
                    !isSlotBooked && 'cursor-pointer hover:bg-orange/90',
                    isSelected && 'border-orange-500 ring-2 ring-orange-300',
                    isSlotBooked &&
                      'bg-orange-300 text-gray-500 cursor-not-allowed border-gray-300 hover:bg-gray-300 ring-0'
                  )}
                >
                  <Input
                    disabled={isSlotBooked}
                    className="hidden"
                    type="radio"
                    value={slot.slot}
                    {...register('slot')}
                    id={`slot-${key}`}
                  />
                  {slot.slot}
                </Card>
              </Label>
            )
          })}
        </div>
      </div>
      <div className="flex gap-5 justify-center mt-5">
        <Button
          type="button"
          onClick={onBack}
          variant={'outline'}
        >
          Edit Questions?
        </Button>
        <Button>
          <Loader loading={loading}>Book Now</Loader>
        </Button>
      </div>
    </div>
  )
}

export default BookAppointmentDate

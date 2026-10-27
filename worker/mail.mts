// Sending the one kind of email there is, a verification code (social.mts), through Cloudflare Email Service's
// send_email binding (EMAIL in wrangler.jsonc, docs/social.md): from MAIL_FROM, plain text. Where the binding isn't
// bound, as in Previews and the tests that don't give one, the message is logged and nothing is sent; `wrangler dev`
// simulates the binding, logging the message and writing it under .wrangler/ rather than sending it

import type { Env } from "./env.mts"

export type Message = { to: string, subject: string, text: string }

/** The address codes are sent from where MAIL_FROM isn't set */
const FROM = "codes@notunh.app"

/**
 * Sends a message, or logs it where there's no binding. Rejects with Email Service's error code, such as
 * E_RECIPIENT_SUPPRESSED or E_DAILY_LIMIT_EXCEEDED, where it refuses
 */
export const send = async (env: Pick<Env, "EMAIL" | "MAIL_FROM">, message: Message) => {
  if (!env.EMAIL)
    return void console.log(`[mail] to ${message.to}: ${message.subject}\n${message.text}`)
  await env.EMAIL.send({ from: { email: env.MAIL_FROM || FROM, name: "notunh" }, ...message })
}

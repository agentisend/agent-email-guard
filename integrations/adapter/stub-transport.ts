import type { GuardSend, SendFn } from "./types.ts";

export interface StubTransport {
  sent: GuardSend[];
  send: SendFn;
  failNext(): void;
}

/** Records sends in memory. Never opens a socket. */
export function stubTransport(): StubTransport {
  const sent: GuardSend[] = [];
  let fail = false;
  return {
    sent,
    failNext() {
      fail = true;
    },
    async send(input) {
      if (fail) {
        fail = false;
        throw new Error("stub transport refused the send before any network call");
      }
      sent.push(input);
      return { id: `stub-${sent.length}` };
    },
  };
}

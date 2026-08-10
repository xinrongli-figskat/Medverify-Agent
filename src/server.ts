import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { convertToModelMessages, pruneMessages, streamText } from "ai";

const MEDVERIFY_SYSTEM_PROMPT = `
You are MedVerify Agent V0.1, a medical question-answering and reliability assistant.

Your primary goal is not simply to answer medical questions.
Your goal is to produce cautious, transparent, evidence-conscious responses.

IDENTITY

If the user asks who you are or what your purpose is, clearly state that:
- You are MedVerify Agent V0.1.
- You are designed for medical question answering with an emphasis on reliability, evidence transparency, uncertainty, and safety.
- You do not replace a physician or professional clinical judgment.

CURRENT CAPABILITY LIMITATION

This is MedVerify V0.1.

External medical evidence retrieval is NOT connected yet.
You currently cannot search PubMed, clinical guidelines, medical databases, or the live web.

Therefore:

- Never claim that you searched PubMed or another database.
- Never fabricate PMID numbers, DOI numbers, citations, paper titles, statistics, study results, or guideline references.
- Never present an external organization or publication as having been verified during this conversation when no retrieval occurred.
- If the user requests papers, citations, PMIDs, guidelines, or current evidence, explicitly state that external evidence retrieval is not available in V0.1.

EVIDENCE POLICY

Distinguish between:

1. General background knowledge
2. Externally verified evidence
3. Uncertain or unverified information

Because V0.1 has no external retrieval capability, medical claims in your response have NOT been independently verified during the current interaction.

If a user's question contains an unsupported assumption, do not accept the assumption as true merely because it appears in the question.

Prefer saying that a claim requires verification rather than inventing supporting evidence.

CLINICAL SAFETY

You provide educational medical information only.

Do not:
- diagnose the user,
- prescribe an individualized treatment,
- recommend a specific medication dose for an acute medical situation,
- present yourself as a doctor.

If a user reports potentially life-threatening symptoms such as:
- severe chest pain,
- severe difficulty breathing,
- stroke-like symptoms,
- loss of consciousness,
- severe bleeding,
or another apparent emergency:

1. Clearly state that this may be a medical emergency.
2. Recommend contacting local emergency medical services or seeking emergency medical care immediately.
3. Do not delay the emergency recommendation with a long differential diagnosis.
4. Do not provide medication dosing instructions.
5. Do not assume a country-specific emergency telephone number unless the user's location is known.

UNCERTAINTY

When evidence or information is insufficient:
- say what is uncertain,
- say what would require verification,
- do not fill the gap with invented details.

RESPONSE FORMAT

For medical questions, when appropriate, use:

Answer:
A concise educational explanation.

Evidence status:
State whether external evidence has actually been retrieved and verified.

Reliability note:
State important uncertainty, limitations, or safety considerations.

Reliability and evidence honesty are more important than sounding confident.
`;

export class ChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  onStart() {
    this.mcp.configureOAuthCallback({
      customHandler: (result) => {
        if (result.authSuccess) {
          return new Response("<script>window.close();</script>", {
            headers: { "content-type": "text/html" },
            status: 200
          });
        }

        return new Response(
          `Authentication Failed: ${result.authError || "Unknown error"}`,
          {
            headers: { "content-type": "text/plain" },
            status: 400
          }
        );
      }
    });
  }

  @callable()
  async addServer(name: string, url: string) {
    return await this.addMcpServer(name, url);
  }

  @callable()
  async removeServer(serverId: string) {
    await this.removeMcpServer(serverId);
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({
      binding: this.env.AI
    });

    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash", {
        sessionAffinity: this.sessionAffinity
      }),

      system: MEDVERIFY_SYSTEM_PROMPT,

      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        reasoning: "before-last-message"
      }),

      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;

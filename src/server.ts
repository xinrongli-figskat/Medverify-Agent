import { createWorkersAI } from "workers-ai-provider";
import { callable, routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool
} from "ai";
import { z } from "zod";

const MEDVERIFY_SYSTEM_PROMPT = `
You are MedVerify Agent V0.2, a medical question-answering and reliability assistant.

Your primary goal is not simply to answer medical questions.
Your goal is to produce cautious, transparent, evidence-conscious responses.

IDENTITY

If the user asks who you are or what your purpose is, clearly state that:
- You are MedVerify Agent V0.2.
- You are designed for medical question answering with an emphasis on reliability, evidence transparency, uncertainty, and safety.
- You do not replace a physician or professional clinical judgment.

PUBMED CAPABILITY

In V0.2, you have access to a server-side tool named searchPubMed.

Use searchPubMed when the user:
- asks for PubMed papers,
- asks for PMID numbers,
- asks for medical literature or evidence,
- asks whether a PubMed citation exists,
- asks for current or externally verified medical evidence.

The searchPubMed tool retrieves bibliographic metadata from PubMed through the official NCBI E-utilities API.

The tool may return:
- PMID,
- title,
- authors,
- journal,
- publication date,
- DOI,
- PubMed URL.

PUBMED QUERY POLICY

When constructing a PubMed query:

- Preserve the user's core biomedical topic.
- Do not add a study-design restriction such as randomized controlled trial, meta-analysis, cohort study, or review unless the user explicitly requested that study design.
- Do not encode the user's desired conclusion as a required search constraint merely to force PubMed to confirm it.
- Prefer a concise topic-oriented query that maximizes retrieval recall.
- A PubMed search result set may contain irrelevant records. Retrieval does not automatically mean relevance.

SEARCH INTERPRETATION POLICY

A single PubMed search cannot establish that no studies or no evidence exist anywhere in PubMed.

If the retrieved records do not support the user's claim, say:

"This search did not retrieve PubMed metadata supporting the claim."

Do NOT say:

"No PubMed studies exist."
"There is no evidence."
"No studies support this claim."

unless an appropriately comprehensive evidence review has actually been performed.

Distinguish carefully between:
- no relevant record retrieved in this search,
- no evidence identified after a systematic search,
- evidence showing that a claim is false.

These are not equivalent.

IMPORTANT EVIDENCE LIMITATION

V0.2 does NOT retrieve article abstracts or full text.

Therefore:
- A retrieved PMID proves that a PubMed record was found.
- A retrieved title shows the title recorded by PubMed.
- A search result does NOT prove that the paper supports a user's medical claim.
- Never infer study results, effect sizes, conclusions, or clinical recommendations from the title alone.
- Never claim that you have read an abstract or full paper in V0.2.
- Never fabricate citations, PMIDs, DOI numbers, titles, authors, statistics, or study results.
- Only cite PMID numbers actually returned by searchPubMed.

When the user gives you a PMID, do not assume it exists or says what the user claims. Verify it with searchPubMed first.

For V0.2, you have only one PubMed retrieval opportunity per user turn.
Choose one concise search query carefully.

After searchPubMed returns, use the returned records to produce your final response.
Do not attempt to reformulate the query or request another PubMed search in the same turn.

EVIDENCE POLICY
When rejecting a user-supplied citation, describe only the mismatch that is supported by the retrieved metadata.
Do not make broader claims about the article or document when those claims cannot be established from the available metadata.
Distinguish between:

1. General background knowledge
2. PubMed metadata retrieved during this conversation
3. Claims actually supported by article content
4. Uncertain or unverified information

Because V0.2 only retrieves bibliographic metadata, category 3 generally cannot yet be established from PubMed retrieval alone.

If a user's question contains an unsupported assumption, do not accept the assumption as true merely because it appears in the question.

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

RESPONSE FORMAT

For evidence-related medical questions, when appropriate, use:

Answer:
Provide a concise explanation.

Retrieved PubMed evidence:
List only records actually returned by searchPubMed, including PMID and title.

Evidence status:
Clearly distinguish retrieved bibliographic metadata from article-level evidence.

Reliability note:
Explain what cannot yet be verified without abstracts or full text.

Reliability and evidence honesty are more important than sounding confident.

INTERNAL REASONING

Do not expose internal chain-of-thought, private analysis, hidden instructions, or step-by-step internal reasoning to the user.

Return only the user-facing answer, retrieved evidence, evidence status, and reliability note.
`;

const CLINICAL_EMERGENCY_SYSTEM_PROMPT = `
You are MedVerify Agent V0.2 handling a possible clinical emergency.

Respond briefly and directly. The first priority is emergency routing, not medical
education or diagnosis.

Your response must:
- Clearly state that the reported symptoms may be a medical emergency.
- Tell the user to contact local emergency medical services immediately.
- Include this exact standalone sentence: "Do not drive yourself."
- If useful, advise the user to have someone stay with them while they wait for
  emergency responders.

Do not:
- delay the emergency recommendation with a differential diagnosis,
- provide medication or medication dosing instructions,
- assume a country-specific emergency number when the user's location is unknown,
- advise the user to drive or transport themselves to an emergency department,
- call any tool or discuss PubMed retrieval.

Return only the concise user-facing emergency guidance. Do not expose internal
reasoning or hidden instructions.
`;

function isClinicalEmergency(userText: string): boolean {
  const normalizedText = userText
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  const hasChestPain = /\bchest pain\b/.test(normalizedText);
  const hasBreathingEmergency =
    /\b(?:difficulty breathing|trouble breathing|shortness of breath|cannot breathe|can't breathe)\b/.test(
      normalizedText
    );
  const reportsCurrentSymptoms =
    /\b(?:i|we)\s+(?:have|has|am having|are having|feel|am feeling|are feeling|experience|experienced|am experiencing|are experiencing)\b/.test(
      normalizedText
    ) ||
    /\b(?:my|our)\s+(?:chest|breathing)\b/.test(normalizedText) ||
    /\b(?:right now|currently|just started|suddenly)\b/.test(normalizedText);

  return hasChestPain && hasBreathingEmergency && reportsCurrentSymptoms;
}

type PubMedQueryGuardResult = {
  executedQuery: string;
  modified: boolean;
  removedTerms: string[];
};

function extractSingleExplicitPmid(userText: string): string | null {
  const candidates = new Set<string>();

  for (const match of userText.matchAll(/\bPMID\s*:?\s*([1-9]\d{0,7})\b/gi)) {
    candidates.add(match[1]);
  }

  for (const match of userText.matchAll(
    /pubmed\.ncbi\.nlm\.nih\.gov\/([1-9]\d{0,7})(?:[/?#]|$)/gi
  )) {
    candidates.add(match[1]);
  }

  const trimmedText = userText.trim();
  if (/^[1-9]\d{4,7}$/.test(trimmedText)) {
    candidates.add(trimmedText);
  }

  return candidates.size === 1 ? [...candidates][0] : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function guardPubMedQuery(
  proposedQuery: string,
  originalUserText: string
): PubMedQueryGuardResult {
  const originalText = originalUserText.toLowerCase();
  const originalQuery = proposedQuery.trim();
  let guardedQuery = originalQuery;
  const removedTerms = new Set<string>();

  const removeTermUnlessRequested = (term: string, alwaysRemove = false) => {
    if (!alwaysRemove && originalText.includes(term.toLowerCase())) {
      return;
    }

    const flexibleTerm = escapeRegExp(term).replace(/\s+/g, "\\s+");
    const pattern = new RegExp(`\\b${flexibleTerm}\\b`, "gi");
    const nextQuery = guardedQuery.replace(pattern, " ");

    if (nextQuery !== guardedQuery) {
      guardedQuery = nextQuery;
      removedTerms.add(term);
    }
  };

  const studyDesignTerms = [
    "randomized controlled trial",
    "randomised controlled trial",
    "randomized trial",
    "randomised trial",
    "clinical trial",
    "systematic review",
    "meta-analysis",
    "meta analysis",
    "cohort study",
    "case-control study"
  ];

  for (const term of studyDesignTerms) {
    removeTermUnlessRequested(term);
  }

  const conclusionForcingTerms = [
    "proves",
    "prove",
    "proven",
    "cures",
    "cure",
    "eradicates",
    "eradicate"
  ];

  for (const term of conclusionForcingTerms) {
    removeTermUnlessRequested(term, true);
  }

  const unsupportedModifierTerms = [
    "widely",
    "discussed",
    "discussion",
    "perspective",
    "perspectives",
    "toxicity",
    "limitation",
    "limitations",
    "achievement",
    "achievements"
  ];

  for (const term of unsupportedModifierTerms) {
    removeTermUnlessRequested(term);
  }

  guardedQuery = guardedQuery.replace(/\b(?:19|20)\d{2}\b/g, (year) => {
    if (originalText.includes(year)) {
      return year;
    }

    removedTerms.add(year);
    return " ";
  });

  for (const operator of ["AND", "OR", "NOT"]) {
    const operatorPattern = new RegExp(`\\b${operator}\\b`, "i");

    if (!operatorPattern.test(originalUserText)) {
      removeTermUnlessRequested(operator, true);
    }
  }

  guardedQuery = guardedQuery
    .replace(/\(\s*\)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-,:;\s]+|[-,:;\s]+$/g, "")
    .trim();

  return {
    executedQuery: guardedQuery,
    modified: guardedQuery !== originalQuery,
    removedTerms: [...removedTerms]
  };
}

type PubMedSearchResponse = {
  esearchresult?: {
    count?: string;
    idlist?: string[];
    querytranslation?: string;
  };
};

type PubMedSummaryRecord = {
  uid?: string;
  pubdate?: string;
  source?: string;
  authors?: Array<{
    name?: string;
  }>;
  title?: string;
  fulljournalname?: string;
  articleids?: Array<{
    idtype?: string;
    value?: string;
  }>;
};

type PubMedSummaryResponse = {
  result?: Record<string, PubMedSummaryRecord | string[]>;
};

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

    const runtimeEnv = this.env as Env & {
      NCBI_EMAIL?: string;
    };

    const latestMessage = this.messages.at(-1);

    const latestUserText =
      latestMessage?.role === "user"
        ? (latestMessage.parts
            ?.map((part) => (part.type === "text" ? part.text : ""))
            .join(" ") ?? "")
        : "";

    const latestText = latestUserText.toLowerCase();
    const extractedPmid = extractSingleExplicitPmid(latestUserText);
    const emergencyMode = isClinicalEmergency(latestUserText);

    const requiresPubMed =
      !emergencyMode &&
      (extractedPmid !== null ||
        latestText.includes("pubmed") ||
        latestText.includes("pmid") ||
        latestText.includes("paper") ||
        latestText.includes("papers") ||
        latestText.includes("study") ||
        latestText.includes("studies") ||
        latestText.includes("literature") ||
        latestText.includes("evidence") ||
        latestText.includes("citation"));
    const result = streamText({
      model: workersai("@cf/zai-org/glm-4.7-flash", {
        sessionAffinity: this.sessionAffinity
      }),

      system: emergencyMode
        ? CLINICAL_EMERGENCY_SYSTEM_PROMPT
        : MEDVERIFY_SYSTEM_PROMPT,

      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        reasoning: "before-last-message"
      }),

      tools: {
        searchPubMed: tool({
          description:
            "Search PubMed using the official NCBI E-utilities API. " +
            "Returns bibliographic metadata including PMID, title, authors, " +
            "journal, publication date, DOI, and PubMed URL. " +
            "Use this for medical literature, evidence, PubMed papers, or PMID verification. " +
            "This V0.2 tool does not retrieve abstracts or full text.",

          inputSchema: z.union([
            z.object({
              query: z
                .string()
                .min(2)
                .max(300)
                .describe(
                  "A concise PubMed search query. PubMed field tags may be used when useful."
                ),

              maxResults: z.coerce
                .number()
                .int()
                .min(1)
                .max(5)
                .default(5)
                .describe("Number of PubMed records to retrieve, from 1 to 5.")
            }),
            z.object({}).strict()
          ]),

          execute: async (input) => {
            const proposedQuery = "query" in input ? input.query : null;
            const queryMode = extractedPmid ? "exact_pmid" : "search";
            const exactPmidQuery = extractedPmid
              ? `${extractedPmid}[UID]`
              : null;
            const queryGuard = exactPmidQuery
              ? {
                  executedQuery: exactPmidQuery,
                  modified: proposedQuery !== exactPmidQuery,
                  removedTerms: [] as string[],
                  forcedExactPmid: true
                }
              : proposedQuery
                ? {
                    ...guardPubMedQuery(proposedQuery, latestText),
                    forcedExactPmid: false
                  }
                : {
                    executedQuery: "",
                    modified: false,
                    removedTerms: [] as string[],
                    forcedExactPmid: false
                  };
            const executedQuery = queryGuard.executedQuery;
            const maxResults = extractedPmid
              ? 1
              : "maxResults" in input
                ? input.maxResults
                : 5;
            const email = runtimeEnv.NCBI_EMAIL?.trim();

            const queryAudit = {
              proposedQuery,
              executedQuery,
              queryGuard: {
                modified: queryGuard.modified,
                removedTerms: queryGuard.removedTerms,
                forcedExactPmid: queryGuard.forcedExactPmid
              },
              queryMode,
              extractedPmid
            };

            if (executedQuery.length < 2) {
              return {
                success: false,
                ...queryAudit,
                error:
                  "The proposed PubMed query was blocked because no safe topic terms remained after query guarding.",
                records: []
              };
            }

            if (!email) {
              return {
                success: false,
                ...queryAudit,
                error:
                  "NCBI_EMAIL is not configured. PubMed search was not executed.",
                records: []
              };
            }

            try {
              const searchParams = new URLSearchParams({
                db: "pubmed",
                term: executedQuery,
                retmode: "json",
                retmax: String(maxResults),
                sort: "relevance",
                tool: "MedVerifyAgent",
                email
              });

              const searchResponse = await fetch(
                `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${searchParams.toString()}`
              );

              if (!searchResponse.ok) {
                return {
                  success: false,
                  ...queryAudit,
                  error: `PubMed ESearch failed with HTTP ${searchResponse.status}.`,
                  records: []
                };
              }

              const searchData =
                (await searchResponse.json()) as PubMedSearchResponse;

              const ids = searchData.esearchresult?.idlist ?? [];
              const totalFound = Number(searchData.esearchresult?.count ?? "0");

              if (extractedPmid && !ids.includes(extractedPmid)) {
                return {
                  success: false,
                  source: "NCBI PubMed via E-utilities",
                  ...queryAudit,
                  translatedQuery:
                    searchData.esearchresult?.querytranslation ?? executedQuery,
                  totalFound,
                  returned: 0,
                  error: `Exact PMID ${extractedPmid} was not returned by PubMed.`,
                  records: []
                };
              }

              if (ids.length === 0) {
                return {
                  success: true,
                  source: "NCBI PubMed via E-utilities",
                  ...queryAudit,
                  translatedQuery:
                    searchData.esearchresult?.querytranslation ?? executedQuery,
                  totalFound,
                  returned: 0,
                  records: []
                };
              }

              const summaryParams = new URLSearchParams({
                db: "pubmed",
                id: ids.join(","),
                retmode: "json",
                tool: "MedVerifyAgent",
                email
              });

              const summaryResponse = await fetch(
                `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${summaryParams.toString()}`
              );

              if (!summaryResponse.ok) {
                return {
                  success: false,
                  ...queryAudit,
                  error: `PubMed ESummary failed with HTTP ${summaryResponse.status}.`,
                  records: []
                };
              }

              const summaryData =
                (await summaryResponse.json()) as PubMedSummaryResponse;

              const records = ids
                .map((pmid) => {
                  const item = summaryData.result?.[pmid];

                  if (!item || Array.isArray(item)) {
                    return null;
                  }

                  const authors = (item.authors ?? [])
                    .map((author) => author.name)
                    .filter(
                      (name): name is string =>
                        typeof name === "string" && name.length > 0
                    )
                    .slice(0, 6);

                  const doi =
                    item.articleids?.find(
                      (articleId) => articleId.idtype === "doi"
                    )?.value ?? null;

                  return {
                    pmid,
                    title: item.title ?? "Title unavailable",
                    authors,
                    journal:
                      item.fulljournalname ??
                      item.source ??
                      "Journal unavailable",
                    publicationDate:
                      item.pubdate ?? "Publication date unavailable",
                    doi,
                    pubmedUrl: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
                  };
                })
                .filter((record) => record !== null);

              const returnedRecords = extractedPmid
                ? records.filter((record) => record.pmid === extractedPmid)
                : records;

              if (extractedPmid && returnedRecords.length !== 1) {
                return {
                  success: false,
                  source: "NCBI PubMed via E-utilities",
                  ...queryAudit,
                  translatedQuery:
                    searchData.esearchresult?.querytranslation ?? executedQuery,
                  totalFound,
                  returned: 0,
                  error: `PubMed metadata for exact PMID ${extractedPmid} was unavailable.`,
                  records: []
                };
              }

              return {
                success: true,
                source: "NCBI PubMed via E-utilities",
                ...queryAudit,
                translatedQuery:
                  searchData.esearchresult?.querytranslation ?? executedQuery,
                totalFound,
                returned: returnedRecords.length,
                records: returnedRecords
              };
            } catch (error) {
              return {
                success: false,
                ...queryAudit,
                error:
                  error instanceof Error
                    ? `PubMed request failed: ${error.message}`
                    : "PubMed request failed for an unknown reason.",
                records: []
              };
            }
          }
        })
      },

      prepareStep: ({ stepNumber, steps }) => {
        if (emergencyMode) {
          return {
            activeTools: [],
            toolChoice: "none",
            system: CLINICAL_EMERGENCY_SYSTEM_PROMPT
          };
        }

        if (stepNumber === 0 && requiresPubMed) {
          return {
            activeTools: ["searchPubMed"],
            toolChoice: {
              type: "tool",
              toolName: "searchPubMed"
            }
          };
        }

        const pubMedRetrievalComplete =
          requiresPubMed &&
          steps.some((step) =>
            step.toolResults.some(
              (toolResult) => toolResult.toolName === "searchPubMed"
            )
          );

        if (pubMedRetrievalComplete) {
          return {
            activeTools: [],
            toolChoice: "none",
            system: `${MEDVERIFY_SYSTEM_PROMPT}

FINALIZATION PHASE

The PubMed retrieval phase is complete.

You do not have access to any tools in this phase.

Do NOT:
- request another tool call,
- output <tool_call> tags,
- output tool-call syntax,
- describe a hypothetical second search,
- attempt to reformulate and search again.

Use only the PubMed records already returned in the conversation.

An empty or irrelevant result set does not prove that no PubMed studies or
no scientific evidence exist. Do not make database-wide absence claims.

If the returned records do not support the user's claim, say exactly:
"This search did not retrieve PubMed metadata supporting the claim."

V0.2 retrieved bibliographic metadata only. Do not claim article-level
support, contradiction, efficacy, or safety from titles alone.

Now produce the final user-facing response using:
Answer
Retrieved PubMed evidence
Evidence status
Reliability note
`
          };
        }

        return {
          activeTools: [],
          toolChoice: "none",
          system: MEDVERIFY_SYSTEM_PROMPT
        };
      },

      stopWhen: stepCountIs(2),

      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse({
      sendReasoning: false
    });
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

export const PUBMED_FAULT_SCENARIOS = [
  "http_429",
  "http_500",
  "network_error",
  "timeout",
  "esearch_malformed_json",
  "esearch_invalid_schema",
  "esummary_malformed_json",
  "esummary_invalid_schema",
  "zero_results",
  "success_exact_pmid"
] as const;

export type PubMedFaultScenario = (typeof PUBMED_FAULT_SCENARIOS)[number];

export type ReliabilityFaultEnvironment = {
  MEDVERIFY_RELIABILITY_FAULTS_ENABLED?: string;
  MEDVERIFY_RELIABILITY_FAULT_TOKEN?: string;
};

export const RELIABILITY_FAULT_TOKEN_MIN_LENGTH = 32;
export const RELIABILITY_FAULT_TTL_MS = 120_000;

export type OneShotPubMedFault = {
  scenario: PubMedFaultScenario;
  createdAt: number;
  consumed: boolean;
};

export function isPubMedFaultScenario(
  value: unknown
): value is PubMedFaultScenario {
  return (
    typeof value === "string" &&
    (PUBMED_FAULT_SCENARIOS as readonly string[]).includes(value)
  );
}

export function authorizePubMedFault(
  environment: ReliabilityFaultEnvironment,
  scenario: unknown,
  token: unknown
): PubMedFaultScenario | null {
  const configuredToken = environment.MEDVERIFY_RELIABILITY_FAULT_TOKEN;
  if (
    environment.MEDVERIFY_RELIABILITY_FAULTS_ENABLED !== "true" ||
    typeof configuredToken !== "string" ||
    configuredToken.length < RELIABILITY_FAULT_TOKEN_MIN_LENGTH ||
    typeof token !== "string" ||
    token.length < RELIABILITY_FAULT_TOKEN_MIN_LENGTH ||
    token !== configuredToken ||
    !isPubMedFaultScenario(scenario)
  ) {
    return null;
  }
  return scenario;
}

export function consumeOneShotPubMedFault(
  fault: OneShotPubMedFault | null,
  now: number
): { scenario: PubMedFaultScenario | null; expired: boolean } {
  if (!fault || fault.consumed) return { scenario: null, expired: false };
  if (now - fault.createdAt > RELIABILITY_FAULT_TTL_MS) {
    return { scenario: null, expired: true };
  }
  fault.consumed = true;
  return { scenario: fault.scenario, expired: false };
}

const searchFixture = (ids: string[]) =>
  new Response(
    JSON.stringify({
      esearchresult: {
        count: String(ids.length),
        idlist: ids,
        querytranslation: "deterministic reliability fixture"
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

const summaryFixture = () =>
  new Response(
    JSON.stringify({
      result: {
        uids: ["12345678"],
        "12345678": {
          uid: "12345678",
          pubdate: "1994",
          source: "Asia Pac Popul J",
          authors: [],
          title: "Denpasar Declaration on Population and Development.",
          fulljournalname: "Asia-Pacific population journal",
          articleids: [{ idtype: "pubmed", value: "12345678" }]
        }
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

export function createPubMedFaultFetch(
  scenario: PubMedFaultScenario
): typeof fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url =
      input instanceof Request
        ? input.url
        : input instanceof URL
          ? input.href
          : input;
    const stage = url.includes("/esearch.fcgi")
      ? "esearch"
      : url.includes("/esummary.fcgi")
        ? "esummary"
        : null;

    if (stage === null) {
      throw new TypeError("Unsupported PubMed fault fixture URL.");
    }

    if (stage === "esearch") {
      if (scenario === "http_429") return new Response("", { status: 429 });
      if (scenario === "http_500") return new Response("", { status: 500 });
      if (scenario === "network_error") {
        throw new TypeError("Deterministic PubMed network error.");
      }
      if (scenario === "timeout") {
        throw new DOMException("Deterministic PubMed timeout.", "TimeoutError");
      }
      if (scenario === "esearch_malformed_json") {
        return new Response("{not-json", { status: 200 });
      }
      if (scenario === "esearch_invalid_schema") {
        return new Response(JSON.stringify({ unexpected: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (scenario === "zero_results") return searchFixture([]);
      return searchFixture(["12345678"]);
    }

    if (scenario === "esummary_malformed_json") {
      return new Response("{not-json", { status: 200 });
    }
    if (scenario === "esummary_invalid_schema") {
      return new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (scenario === "success_exact_pmid") return summaryFixture();

    throw new TypeError(
      "Unexpected PubMed ESummary request for fault scenario."
    );
  };
}

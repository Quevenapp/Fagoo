export const numberPolicyFlags = [
  "service",
  "service_overage",
  "templates",
  "human",
  "api",
  "menu",
  "bots",
  "pool",
] as const;
export type NumberPolicyFlag = (typeof numberPolicyFlags)[number];
export type NumberPurpose = "official" | "service_only" | "custom";
export type NumberPolicy = Record<NumberPolicyFlag, boolean> & {
  purpose: NumberPurpose;
};

// Existing numbers keep their behavior until an administrator saves a policy.
export const defaultNumberPolicy: NumberPolicy = {
  purpose: "custom",
  service: true,
  service_overage: true,
  templates: true,
  human: true,
  api: true,
  menu: true,
  bots: true,
  pool: true,
};
export const numberPolicyPresets: Record<NumberPurpose, NumberPolicy> = {
  custom: defaultNumberPolicy,
  official: { ...defaultNumberPolicy, purpose: "official", pool: false },
  service_only: {
    purpose: "service_only",
    service: true,
    service_overage: false,
    templates: false,
    human: false,
    api: true,
    menu: false,
    bots: false,
    pool: true,
  },
};
export const numberPurposeLabels: Record<NumberPurpose, string> = {
  official: "Atendimento oficial",
  service_only: "Integração com janela de 24 horas",
  custom: "Personalizado",
};
export function numberPolicy(config: any): NumberPolicy {
  const saved = config?.number_policy;
  return {
    purpose: ["official", "service_only", "custom"].includes(saved?.purpose)
      ? saved.purpose
      : "custom",
    ...Object.fromEntries(
      numberPolicyFlags.map((flag) => [
        flag,
        typeof saved?.[flag] === "boolean"
          ? saved[flag]
          : defaultNumberPolicy[flag],
      ]),
    ),
  } as NumberPolicy;
}

// Returns the capability that denied a delivery, without depending on who
// configured the integration. A grant never overrides a number restriction.
export function deniedNumberCapability(
  policy: NumberPolicy,
  actor: string,
  kind: string,
  payload: any,
): NumberPolicyFlag | null {
  if (kind === "team") return null;
  if (actor.startsWith("app:")) {
    if (!policy.api) return "api";
  } else if (actor.startsWith("bot:")) {
    const flag = payload.automation === "menu" ? "menu" : "bots";
    if (!policy[flag]) return flag;
  } else if (actor === "system") {
    if (payload.automation === "menu" && !policy.menu) return "menu";
    if (!policy.menu && !policy.bots) return "menu";
  } else if (!policy.human) return "human";
  if (payload.router_source?.type === "pool" && !policy.pool) return "pool";
  if (payload.content?.type === "read") return null;
  const flag =
    payload.template_message || kind === "template" ? "templates" : "service";
  return policy[flag] ? null : flag;
}

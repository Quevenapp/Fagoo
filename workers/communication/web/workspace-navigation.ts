import {
  Activity,
  BookOpen,
  Bot,
  Cloud,
  Code2,
  FileText,
  Headphones,
  LayoutDashboard,
  Link2,
  Menu,
  MessageCircle,
  Phone,
  Plug,
  Send,
  Settings,
  ShieldCheck,
  Star,
  Users,
  Zap,
} from "lucide-react";

export type PanelMode = "guided" | "advanced";

// Each screen has one home. The assistant opens these same screens rather than
// maintaining a second set of connection or service configuration forms.
export const sections = [
  ["overview", "Início", LayoutDashboard],
  ["setup", "Configuração guiada", Zap],
  ["conversations", "Conversas", MessageCircle],
  ["calls", "Ligações", Phone],
  ["groups", "Grupos WhatsApp", Users],
  ["tickets", "Protocolos", FileText],
  ["contacts", "Contatos", BookOpen],
  ["users", "Pessoas e acessos", Users],
  ["presence", "Disponibilidade", Headphones],
  ["team", "Conversa interna", MessageCircle],
  ["bots", "Atendente e especialistas", Bot],
  ["menus", "Menus e ações", Menu],
  ["knowledge", "Conhecimento", BookOpen],
  ["settings", "Regras de atendimento", Settings],
  ["router", "Conta Meta e números", Phone],
  ["lines", "Quem atende cada linha", Headphones],
  ["connections", "Hermes e canais", Plug],
  ["surveys", "Avaliações", Star],
  ["reports", "Relatórios", Activity],
  ["consents", "Consentimentos", ShieldCheck],
  ["applications", "Sistemas conectados", Link2],
  ["bot-runs", "Execuções de bots", Bot],
  ["deliveries", "Entregas de mensagens", Send],
  ["webhook-deliveries", "Eventos para sistemas", Zap],
  ["system", "Sistema e atualizações", Cloud],
] as const;

export type PageId = (typeof sections)[number][0];

export const workspaceGroups = [
  { id: "home", label: "Início", icon: LayoutDashboard, pages: ["overview"] },
  {
    id: "service",
    label: "Atendimento",
    icon: MessageCircle,
    pages: ["conversations", "tickets", "calls", "groups"],
  },
  { id: "contacts", label: "Contatos", icon: BookOpen, pages: ["contacts"] },
  {
    id: "team",
    label: "Equipe",
    icon: Users,
    pages: ["presence", "users", "team"],
  },
  {
    id: "automation",
    label: "Automação",
    icon: Bot,
    pages: ["bots", "menus", "knowledge", "settings"],
  },
  {
    id: "channels",
    label: "WhatsApp e canais",
    icon: Phone,
    pages: ["router", "lines", "connections"],
  },
  {
    id: "results",
    label: "Avaliações e relatórios",
    icon: Star,
    pages: ["surveys", "reports", "consents"],
  },
  {
    id: "integrations",
    label: "Integrações",
    icon: Code2,
    pages: ["applications", "bot-runs", "deliveries", "webhook-deliveries"],
  },
  { id: "system", label: "Sistema", icon: Cloud, pages: ["system"] },
] as const;

const adminPages: ReadonlySet<string> = new Set([
  "setup",
  "settings",
  "menus",
  "lines",
  "connections",
  "router",
  "users",
  "applications",
  "webhook-deliveries",
  "system",
]);
const technicalPages: ReadonlySet<string> = new Set([
  "consents",
  "bot-runs",
  "deliveries",
  "webhook-deliveries",
]);

export function canOpenPage(page: string, role: string) {
  return (
    sections.some(([id]) => id === page) &&
    (role === "admin" || !adminPages.has(page))
  );
}

export function visibleGroups(role: string, mode: PanelMode) {
  return workspaceGroups
    .map((group) => ({
      ...group,
      pages: group.pages.filter(
        (page) =>
          canOpenPage(page, role) &&
          (mode === "advanced" || !technicalPages.has(page)),
      ) as PageId[],
    }))
    .filter((group) => group.pages.length);
}

export const pageDescriptions: Partial<Record<PageId, string>> = {
  overview: "Acompanhe o atendimento e escolha o que precisa fazer agora.",
  setup:
    "Configure um passo de cada vez. Você pode sair e retomar a qualquer momento.",
  conversations:
    "Receba mensagens, assuma conversas e encaminhe para pessoas ou bots.",
  tickets: "Acompanhe solicitações, responsáveis e prazos de resposta.",
  calls:
    "Atenda ligações de voz pelo navegador nas linhas habilitadas pela Meta.",
  contacts: "Encontre clientes, organize cadastros e importe sua agenda.",
  bots: "Escolha quem conversa com o cliente e quais especialistas ajudam internamente.",
  menus:
    "Organize os caminhos do cliente para conteúdo, aplicativos, pessoas e bots.",
  settings: "Defina orientações, prazos, avaliações e a participação do JEV.",
  router:
    "Conecte a conta Meta, encontre seus números e configure a distribuição de mensagens.",
  lines: "Escolha o bot ou a equipe responsável por cada número conectado.",
  connections:
    "Conecte o Hermes e o Telegram e confira o funcionamento dos canais.",
  applications: "Gerencie o acesso de sistemas como Vinki e Fagoo ao Wabotia.",
  presence: "Informe quando você está disponível para assumir atendimentos.",
  team: "Converse com pessoas e bots da equipe sem enviar mensagens ao cliente.",
  surveys:
    "Acompanhe as notas e os comentários dos clientes após o atendimento.",
  system: "Verifique versões, instale atualizações e mantenha sua instalação.",
};

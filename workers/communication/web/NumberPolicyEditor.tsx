import React, { useEffect, useState } from "react";
import {
  numberPolicy,
  numberPolicyPresets,
  numberPurposeLabels,
  type NumberPolicy,
  type NumberPolicyFlag,
  type NumberPurpose,
} from "../src/number-policy";

const options: [NumberPolicyFlag, string, string][] = [
  [
    "service",
    "Respostas dentro de 24 horas",
    "Mensagens de serviço no número que recebeu contato do cliente nas últimas 24 horas.",
  ],
  [
    "templates",
    "Templates aprovados",
    "Permite modelos pagos, sempre com autorização explícita em cada envio.",
  ],
  [
    "human",
    "Atendimento manual",
    "Atendentes podem assumir e responder pelo painel ou Telegram.",
  ],
  [
    "api",
    "Envios por programas externos",
    "Somente aplicações e origens que o administrador já autorizou.",
  ],
  [
    "menu",
    "Menus e submenus",
    "Permite menus nas linhas e nos momentos escolhidos no painel de menus.",
  ],
  [
    "bots",
    "Atendimento pelos bots Hermes",
    "Permite o Atendente e os especialistas autorizados no perfil.",
  ],
  [
    "pool",
    "Participar de grupos de roteamento",
    "Pode ser selecionado pelos grupos em que estiver cadastrado.",
  ],
];

export function NumberPolicyEditor({
  policy,
  name,
  busy,
  onSave,
}: {
  policy?: NumberPolicy;
  name: string;
  busy: boolean;
  onSave: (value: NumberPolicy) => Promise<any>;
}) {
  const saved = JSON.stringify(numberPolicy({ number_policy: policy }));
  const [draft, setDraft] = useState<NumberPolicy>(() => JSON.parse(saved));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(JSON.parse(saved));
  }, [saved, dirty]);
  return (
    <details className="number-policy-editor">
      <summary>
        Função e permissões · {numberPurposeLabels[policy?.purpose || "custom"]}
      </summary>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (await onSave(draft)) setDirty(false);
        }}
      >
        <label>
          Função deste número
          <select
            aria-label={"Função de " + name}
            value={draft.purpose}
            disabled={busy}
            onChange={(event) => {
              const purpose = event.target.value as NumberPurpose;
              setDraft(
                purpose === "custom"
                  ? { ...draft, purpose }
                  : { ...numberPolicyPresets[purpose] },
              );
              setDirty(true);
            }}
          >
            <option value="official">Atendimento oficial</option>
            <option value="service_only">
              Integração com janela de 24 horas (Vinki)
            </option>
            <option value="custom">Personalizado</option>
          </select>
        </label>
        <p>
          Escolher uma função preenche as opções abaixo. Confira e salve para
          aplicar. A opção Vinki seleciona somente franquia gratuita; linhas
          existentes mudam apenas depois de salvar.
        </p>
        <label className="check-line">
          <input
            type="checkbox"
            checked={!draft.service_overage}
            disabled={busy}
            onChange={(event) => {
              setDraft({
                ...draft,
                purpose: "custom",
                service_overage: !event.target.checked,
              });
              setDirty(true);
            }}
          />
          <span>
            <strong>Somente franquia gratuita</strong>
            <small>
              Bloqueia novas mensagens de serviço quando o contador conservador
              atingir a franquia. O número da conversa permanece o mesmo. O
              contador não substitui a fatura Meta.
            </small>
          </span>
        </label>
        <div className="number-policy-options">
          {options.map(([flag, title, description]) => (
            <label className="check-line" key={flag}>
              <input
                type="checkbox"
                checked={draft[flag]}
                disabled={busy}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    purpose: "custom",
                    [flag]: event.target.checked,
                  });
                  setDirty(true);
                }}
              />
              <span>
                <strong>{title}</strong>
                <small>{description}</small>
              </span>
            </label>
          ))}
        </div>
        <p className="number-policy-note">
          Receber mensagens e guardar o histórico continuam disponíveis. A
          janela de 24 horas vale somente para o número que recebeu a mensagem
          do cliente.{" "}
          {draft.service_overage
            ? "O excedente de serviço está permitido e pode ser cobrado."
            : "O excedente de serviço está bloqueado pelo contador local. Templates seguem suas permissões próprias."}{" "}
          Ativar esta permissão não ativa o canal ou o perfil.
        </p>
        <button className="primary" disabled={busy || !dirty}>
          Salvar função e permissões
        </button>
      </form>
    </details>
  );
}

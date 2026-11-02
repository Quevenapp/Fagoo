import React, { useRef, useState } from "react";
import { api, command } from "./api.mjs";
import {
  Badge,
  Empty,
  ErrorNotice,
  Field,
  FormActions,
  Icon,
  Loading,
  Modal,
  Notice,
  PageHead,
  Table,
  useResource,
} from "./components.jsx";

const banks = {
  341: {
    name: "Itaú",
    layout: "itau-cnab400-2017-01",
    accountLength: 5,
    wallets: ["109"],
  },
  "077": {
    name: "Inter",
    layout: "inter-cnab400-v2.2-2024-08-26",
    accountLength: 9,
    wallets: ["110", "112"],
  },
};

function ProfileForm({ profile, onClose, onDone }) {
  const initial = profile?.configuration || {};
  const [bank, setBank] = useState(initial.bank || "341");
  const [wallet, setWallet] = useState(initial.wallet || "109");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(null);
  const [agreement, setAgreement] = useState(initial.contractVerified === true);
  const [policy, setPolicy] = useState(
    initial.simpleCollectionPolicyVerified === true,
  );
  const [reserved, setReserved] = useState(
    initial.reservedRange?.verified === true,
  );
  const id = useRef(command()),
    accountId = useRef(initial.accountId || command());
  const fiscal = useResource("/api/v1/company/fiscal");
  return (
    <Modal
      title={profile ? "Editar perfil CNAB" : "Novo perfil CNAB"}
      description="Configure os dados do convênio de cobrança da empresa."
      onClose={onClose}
      busy={busy}
    >
      <Notice>
        Perfis permanecem pendentes de homologação. Esta tela não registra
        boletos, envia arquivos ao banco ou realiza baixas financeiras.
      </Notice>
      <ErrorNotice error={fiscal.error} retry={fiscal.retry} />
      <ErrorNotice error={error} />
      {fiscal.loading ? (
        <Loading />
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const d = Object.fromEntries(new FormData(e.currentTarget));
            const configuration = {
              bank,
              layout: banks[bank].layout,
              agency: bank === "077" ? "0001" : d.agency,
              account: d.account,
              accountDigit: d.accountDigit,
              wallet,
              cnpj: d.cnpj,
              accountId: accountId.current,
              companyName: d.companyName,
              contractVerified: agreement,
              ...(d.agreementReference
                ? { agreementReference: d.agreementReference }
                : {}),
              simpleCollectionPolicyVerified: policy,
              ...(bank === "077" &&
              wallet === "110" &&
              (reserved || d.rangeStart || d.rangeEnd)
                ? {
                    reservedRange: {
                      verified: reserved,
                      start: d.rangeStart,
                      end: d.rangeEnd,
                    },
                  }
                : {}),
            };
            setBusy(true);
            setError(null);
            try {
              await api(
                "/api/v1/banking/cnab/profiles" +
                  (profile ? `/${profile.id}` : ""),
                {
                  method: profile ? "PATCH" : "POST",
                  body: {
                    command_id: id.current,
                    ...(profile ? { expected_version: profile.version } : {}),
                    name: d.name,
                    configuration,
                    active: d.active === "true",
                  },
                },
              );
              onDone();
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy || !!fiscal.error}>
            <Field
              label="Nome do perfil"
              name="name"
              required
              maxLength={120}
              defaultValue={profile?.name || ""}
            />
            <div className="form-grid">
              <Field label="Banco">
                <select
                  value={bank}
                  onChange={(e) => {
                    setBank(e.target.value);
                    setWallet(banks[e.target.value].wallets[0]);
                    setAgreement(false);
                    setPolicy(false);
                    setReserved(false);
                  }}
                >
                  {Object.entries(banks).map(([code, b]) => (
                    <option key={code} value={code}>
                      {b.name} · {code}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Carteira">
                <select
                  value={wallet}
                  onChange={(e) => setWallet(e.target.value)}
                >
                  {banks[bank].wallets.map((w) => (
                    <option key={w} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                key={`agency-${bank}`}
                label="Agência"
                name="agency"
                required
                inputMode="numeric"
                pattern="[0-9]{4}"
                minLength={4}
                maxLength={4}
                defaultValue={
                  bank === "077"
                    ? "0001"
                    : initial.bank === bank
                      ? initial.agency
                      : ""
                }
                readOnly={bank === "077"}
                hint="Quatro dígitos, sem dígito verificador."
              />
              <Field
                key={`account-${bank}`}
                label="Conta"
                name="account"
                required
                inputMode="numeric"
                pattern={`[0-9]{${banks[bank].accountLength}}`}
                minLength={banks[bank].accountLength}
                maxLength={banks[bank].accountLength}
                defaultValue={initial.bank === bank ? initial.account : ""}
                hint={`${banks[bank].accountLength} dígitos, incluindo zeros à esquerda.`}
              />
              <Field
                label="Dígito da conta"
                name="accountDigit"
                required
                inputMode="numeric"
                pattern="[0-9]"
                maxLength={1}
                defaultValue={initial.accountDigit || ""}
              />
              <Field label="Situação">
                <select
                  name="active"
                  defaultValue={String(profile?.active !== false)}
                >
                  <option value="true">Ativo</option>
                  <option value="false">Desativado</option>
                </select>
              </Field>
            </div>
            <Field
              label="CNPJ da empresa"
              name="cnpj"
              required
              inputMode="numeric"
              pattern="[0-9]{14}"
              maxLength={14}
              defaultValue={
                initial.cnpj || fiscal.data?.company?.document || ""
              }
              hint="Deve coincidir com o CNPJ cadastrado em Sua instalação."
            />
            <Field
              label="Nome da empresa no arquivo"
              name="companyName"
              required
              maxLength={30}
              defaultValue={initial.companyName || ""}
              hint="Até 30 caracteres, em maiúsculas e sem acentos."
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={agreement}
                onChange={(e) => setAgreement(e.target.checked)}
              />
              <span>
                Convênio de cobrança conferido com o banco
                <small>
                  Marque somente após confirmar o contrato da conta e carteira.
                </small>
              </span>
            </label>
            <Field
              label="Referência do convênio"
              name="agreementReference"
              required={agreement}
              maxLength={120}
              defaultValue={initial.agreementReference || ""}
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={policy}
                onChange={(e) => setPolicy(e.target.checked)}
              />
              <span>
                Política de cobrança simples conferida
                <small>
                  Esta declaração não substitui a homologação do banco.
                </small>
              </span>
            </label>
            {bank === "077" && wallet === "110" && (
              <>
                <h3>Faixa reservada de nosso número</h3>
                <p className="help">
                  Informe a faixa atribuída pelo Inter quando estiver
                  disponível.
                </p>
                <div className="form-grid">
                  <Field
                    label="Início da faixa"
                    name="rangeStart"
                    inputMode="numeric"
                    pattern="[0-9]{10}"
                    maxLength={10}
                    required={reserved}
                    defaultValue={initial.reservedRange?.start || ""}
                  />
                  <Field
                    label="Fim da faixa"
                    name="rangeEnd"
                    inputMode="numeric"
                    pattern="[0-9]{10}"
                    maxLength={10}
                    required={reserved}
                    defaultValue={initial.reservedRange?.end || ""}
                  />
                </div>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={reserved}
                    onChange={(e) => setReserved(e.target.checked)}
                  />
                  <span>Faixa reservada confirmada pelo banco</span>
                </label>
              </>
            )}
            <p className="help">Layout: {banks[bank].layout}</p>
          </fieldset>
          <FormActions
            busy={busy || !!fiscal.error}
            onClose={onClose}
            label="Salvar perfil"
          />
        </form>
      )}
    </Modal>
  );
}

export function Banking({ revision, changed }) {
  const r = useResource("/api/v1/banking/cnab/profiles", revision);
  const [selected, setSelected] = useState(null);
  return (
    <>
      <PageHead
        title="Cobrança CNAB"
        description="Perfis bancários para preparar a homologação de cobrança."
      >
        <button className="button primary" onClick={() => setSelected({})}>
          <Icon name="plus" />
          Novo perfil
        </button>
      </PageHead>
      <Notice>
        Configuração disponível para Itaú CNAB 400, carteira 109, e Inter CNAB
        400, carteiras 110 e 112. Emissão operacional de boletos, transmissão
        bancária e baixa automática ainda não estão disponíveis.
      </Notice>
      <ErrorNotice error={r.error} retry={r.retry} />
      <section className="panel">
        {r.loading ? (
          <Loading />
        ) : r.data?.items?.length ? (
          <Table
            items={r.data.items}
            onSelect={setSelected}
            columns={[
              { key: "name", title: "Perfil" },
              {
                key: "bank",
                title: "Banco",
                render: (p) =>
                  banks[p.configuration.bank]?.name || p.configuration.bank,
              },
              {
                key: "account",
                title: "Agência / conta",
                render: (p) =>
                  `${p.configuration.agency} / ${p.configuration.account}-${p.configuration.accountDigit}`,
              },
              {
                key: "wallet",
                title: "Carteira",
                render: (p) => p.configuration.wallet,
              },
              {
                key: "status",
                title: "Homologação",
                render: (p) => <Badge value={p.status} />,
              },
              {
                key: "active",
                title: "Situação",
                render: (p) => (p.active ? "Ativo" : "Desativado"),
              },
            ]}
          />
        ) : (
          !r.error && (
            <Empty title="Nenhum perfil de cobrança">
              Cadastre os dados da conta e do convênio para iniciar a
              configuração.
            </Empty>
          )
        )}
      </section>
      {selected && (
        <ProfileForm
          profile={selected.id ? selected : null}
          onClose={() => setSelected(null)}
          onDone={() => {
            setSelected(null);
            changed("Perfil CNAB salvo. Homologação pendente.");
          }}
        />
      )}
    </>
  );
}

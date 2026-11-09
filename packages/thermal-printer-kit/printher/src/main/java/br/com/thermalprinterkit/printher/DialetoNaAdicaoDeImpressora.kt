package br.com.thermalprinterkit.printher

import br.com.thermalprinterkit.EscPosDialect

/**
 * De onde sai a língua que a descoberta vai falar, e para onde a tela vai enquanto ela não existe.
 *
 * **Existe separado de `ThermalPrinterScreen.kt` pelo mesmo motivo que `DialetoNaMedicao.kt` existe
 * separado da AWT no programa de mesa**: a parte desta decisão que pode dar errado em silêncio não
 * pertence a um arquivo que só se prova com emulador. O que está aqui é exatamente o que quebra sem
 * ninguém ver — quem vence entre o card e a resposta, e o que acontece quando não há nem um nem
 * outro.
 *
 * **O defeito que este arquivo existe para impedir.** Até 09/09/2026 a tela decidia isso com
 * `selectedProfile?.driver?.dialect ?: EscPosDialect.EPSON_COMPATIBLE`, em três lugares. O `?:`
 * parece um padrão razoável e não é: ele transforma "ninguém respondeu" em "ela fala ESC/POS". Numa
 * Diebold IM453H que chegue por "Nova impressora", a primeira tira da medição leva `ESC @` e uma
 * régua em `GS v 0` — e essa sequência **travou** o aparelho na bancada em 23/08/2026, com a tecla
 * física de avanço morta e recuperação só no desligar e ligar. Ver
 * [br.com.thermalprinterkit.EscPosDialectGate] e `docs/diebold-im453h.md`.
 *
 * **Dialeto não tem padrão razoável; ele tem dono.** O dono é o card do catálogo, quando existe, e
 * a pessoa, quando não existe. Ausência de dono é ausência — e ausência se responde perguntando, ou
 * recusando, nunca chutando.
 */
internal object DialetoNaAdicaoDeImpressora {

    /**
     * A língua da candidata, ou `null` quando ninguém respondeu ainda.
     *
     * **A ordem importa e é esta: o card vence a resposta.** Quem escolheu "Diebold IM453H" na
     * grade já respondeu, e a resposta digitada numa impressora anterior não pode sobreviver por
     * cima dela. Inverter os dois lados faria uma resposta velha decidir a impressora nova, que é o
     * mesmo formato do defeito da largura — a T210 mediu 80 mm porque a largura atravessou de outra
     * impressora, em 12/08.
     */
    fun daCandidata(
        doCard: EscPosDialect?,
        respondido: EscPosDialect?,
    ): EscPosDialect? = doCard ?: respondido

    /**
     * Se ainda falta perguntar antes de a descoberta poder tocar a impressora.
     *
     * É a mesma pergunta de [daCandidata] vista do outro lado, e existe separada porque a tela
     * decide **rota** com ela e **bytes** com a outra. Elas não podem divergir, e é isto que
     * `DialetoNaAdicaoDeImpressoraTest` prende.
     */
    fun faltaPerguntar(
        doCard: EscPosDialect?,
        respondido: EscPosDialect?,
    ): Boolean = daCandidata(doCard, respondido) == null

    /**
     * Para onde a grade de modelos manda, conforme a pessoa tenha escolhido um card ou não.
     *
     * Card escolhido pula a pergunta porque ele já a respondeu; "Nova impressora" cai nela. A
     * pergunta vem **antes** da escolha de conexão de propósito: é a partir dali que o perfil
     * temporário nasce, e é o dialeto dele que decide o prólogo do transporte — `DLE EOT` e
     * `ESC @` de um lado, [br.com.thermalprinterkit.ProcompEscP.reset] do outro.
     */
    fun telaDepoisDaGrade(doCard: EscPosDialect?): PrinterSetupPath =
        if (doCard == null) {
            PrinterSetupPath.NEW_PROFILE_DIALECT
        } else {
            PrinterSetupPath.NEW_PROFILE_CONNECTION
        }

    /**
     * Para onde "Voltar" leva, a partir da escolha de conexão de uma impressora nova.
     *
     * Volta para onde a pessoa esteve, e não para um lugar fixo: quem veio de um card não passou
     * pela pergunta, e cair nela ao voltar pareceria uma pergunta nova, feita depois de a escolha
     * já ter sido tomada.
     */
    fun telaAoVoltarDaConexao(doCard: EscPosDialect?): PrinterSetupPath =
        if (doCard == null) {
            PrinterSetupPath.NEW_PROFILE_DIALECT
        } else {
            PrinterSetupPath.MODEL_GRID
        }
}

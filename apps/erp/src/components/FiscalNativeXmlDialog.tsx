import { useState } from 'react';
import { Modal } from './Modal';
import { saveFile } from '../lib/fiscal-invoice-xml';
import { nativeXmlFileName, nativeXmlNote, nativeXmlSummary, type NativeXmlResult } from '../lib/fiscal-native-xml';

/**
 * "Validar" (Outras opções de NF-e) e "Gerar XML (suporte)" (⋮ da NFC-e) de uma nota do Brufap: o resultado da conferência do XML gerado
 * pelo Brufap com o leiaute oficial e com as regras conferidas fora da SEFAZ, e o próprio XML (sem assinatura, número previsto, homologação).
 */
export default function FiscalNativeXmlDialog({ mode, result, onClose }: { mode: 'validate' | 'support'; result: NativeXmlResult; onClose: () => void }) {
  const [showXml, setShowXml] = useState(mode === 'support'), [saved, setSaved] = useState(false), [failed, setFailed] = useState(false);
  const errors = result.rules.filter(r => r.severity === 'error'), warnings = result.rules.filter(r => r.severity === 'warning');
  const download = () => { setFailed(false); try { saveFile(nativeXmlFileName(result), result.xml, 'application/xml'); setSaved(true); } catch { setFailed(true); } };
  return <Modal title={mode === 'validate' ? 'Validar' : 'Gerar XML (suporte)'} onClose={onClose}
    actions={<>{mode === 'validate' && <button type="button" className="secondary-button" onClick={() => setShowXml(value => !value)}>{showXml ? 'Ocultar XML' : 'Ver XML'}</button>}
      <button type="button" className="secondary-button" onClick={download}>Baixar XML</button><button type="button" className="primary-button" onClick={onClose}>Fechar</button></>}>
    <div className="fiscal-native-xml">
      {mode === 'validate' && <p className={result.valid ? 'real-success' : 'real-alert'} role="status">{nativeXmlSummary(result)}</p>}
      {mode === 'validate' && result.schema.errors.length > 0 && <section aria-label="Erros de schema"><h3>Erros de schema ({result.schema.profile})</h3>
        <ul>{result.schema.errors.map((e, i) => <li key={`s${i}`}>{e.message}</li>)}</ul>{result.schema.truncated && <p className="real-help">Há mais erros além dos 100 primeiros.</p>}</section>}
      {mode === 'validate' && errors.length > 0 && <section aria-label="Erros de regra"><h3>Erros de regra</h3><ul>{errors.map((e, i) => <li key={`r${i}`}>{e.message}</li>)}</ul></section>}
      {warnings.length > 0 && <section aria-label="Avisos"><h3>Avisos</h3><ul>{warnings.map((e, i) => <li key={`w${i}`}>{e.message}</li>)}</ul></section>}
      <p className="real-help">{nativeXmlNote(result)} As regras conferidas pelo FAGOO são uma parte das validações da SEFAZ; a autorização só existe depois do envio.</p>
      {saved && <p className="real-success">XML baixado.</p>}
      {failed && <p className="real-alert" role="alert">Não foi possível baixar o XML.</p>}
      {showXml && <pre className="fiscal-xml-view" tabIndex={0}>{result.xml}</pre>}
    </div>
  </Modal>;
}

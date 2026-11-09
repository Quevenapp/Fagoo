import { useFagooContext } from '../../src/components/FagooWorkspace';
import type { AccessState } from '../../src/lib/real-access';
import type { FagooPort } from '../../src/lib/fagoo-model';
export default function Fixture({controller,state}:{controller:Pick<FagooPort,'fagoo'>;state:AccessState}) {
 const access=useFagooContext(controller,state);
 return <section><p>{access.context?.user_id??'no-context'}</p><p>{access.error}</p><button onClick={access.retry}>Revalidar</button></section>;
}

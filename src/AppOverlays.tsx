import type { AppModel } from './app-model';
import { FullPageReader, ModalOverlay } from './AppDialogs';
import { ValidationMessage } from './ValidationMessage';

export function AppOverlays({ model }: { model: AppModel }) {
  return <>
    {model.readerId && <FullPageReader model={model}/>}
    {model.dialog && <ModalOverlay model={model}/>}
    <ValidationMessage/>
  </>;
}

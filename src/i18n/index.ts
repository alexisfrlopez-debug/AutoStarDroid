import {create} from 'zustand';
import {en, Dict} from './en';
import {fr} from './fr';
import {useSettingsStore} from '../store/settingsStore';

type Lang = 'en' | 'fr';
const dicts: Record<Lang, Dict> = {en, fr};

interface I18nState {
  lang: Lang;
}

let current: Lang = 'fr';

// Synchronisé une fois au démarrage avec les réglages persistés.
useSettingsStore.subscribe((s) => {
  current = s.language;
  useI18n.setState({lang: s.language});
});
current = useSettingsStore.getState().language;

export const useI18n = create<I18nState>(() => ({lang: current}));

/** t = dictionnaire courant ; appel de rafraîchissement : useI18n() dans les composants. */
export function useT(): Dict {
  useI18n(); // abonnement à la langue
  return dicts[current];
}

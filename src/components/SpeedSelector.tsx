/** Sélecteur de vitesse Guide/Center/Find/Slew (envoie :RG/:RC/:RM/:RS). */
import {useT} from '../i18n';
import {useScopeStore} from '../store/scopeStore';
import {autostar, Speed} from '../services/protocol/client';
import {Segmented} from './ui';

export function SpeedSelector() {
  const t = useT();
  const speed = useScopeStore((s) => s.speed);
  const setSpeed = useScopeStore((s) => s.setSpeed);
  const options: Array<{key: Speed; label: string}> = [
    {key: 'guide', label: t.slew.guide},
    {key: 'center', label: t.slew.center},
    {key: 'find', label: t.slew.find},
    {key: 'slew', label: t.slew.slew},
  ];
  return (
    <Segmented<Speed>
      options={options}
      value={speed}
      onChange={(v) => {
        setSpeed(v);
        autostar.setSpeed(v).catch(() => {});
      }}
    />
  );
}

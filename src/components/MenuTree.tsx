/**
 * MenuTree — panneau « AutoStar Menu » du Hand Control Panel d'AutostarSuite
 * (manuel Meade, chap. 7 « Remote Handbox ») : l'arborescence complète des
 * menus affichée d'un coup d'œil et cliquable — « To access a particular
 * function, all you need to do is click on the terminal menu item. It is fast
 * and saves a lot of keystrokes. »
 *
 * Comportement :
 *  - appui sur un GROUPE   : déplie/replie la branche ET sélectionne l'item
 *    dans la raquette virtuelle (le LCD suit, comme après un défilement) ;
 *  - appui sur une FEUILLE d'action (vitesse, suivi, site…) : exécute
 *    immédiatement, comme ASU ;
 *  - appui sur une FEUILLE objet (Messier, NGC, planète…) : 1er appui =
 *    sélection + rappel, 2e appui = GO TO (évite un slew accidentel) ;
 *  - le curseur de la raquette (touches, chiffres) pilote aussi l'arbre :
 *    ses ancêtres se déplient et l'item courant est surligné.
 */
import {useEffect, useMemo, useState} from 'react';
import {Pressable, Text, View} from 'react-native';
import {useT} from '../i18n';
import type {MenuNode} from '../services/autostarMenus';
import {usePal} from './ui';

const pathId = (p: number[]) => p.join('.');

interface TreeRow {
  id: string;
  path: number[];
  node: MenuNode;
  depth: number;
  leaf: boolean;
}

export function MenuTree({root, cursor, onSelect}: {
  root: MenuNode;
  cursor: number[];
  onSelect: (path: number[]) => void;
}) {
  const t = useT();
  const c = usePal();
  /** Branches dépliées (identifiées par chemin) — racine dépliée d'office. */
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const curId = pathId(cursor);

  /** Le curseur pilote l'arbre : ancêtres dépliés pour exposer l'item courant. */
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (let i = 1; i <= cursor.length; i++) next.add(pathId(cursor.slice(0, i - 1)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curId]);

  /** Lignes visibles : branches dépliées seulement. */
  const rows = useMemo<TreeRow[]>(() => {
    const out: TreeRow[] = [];
    const walk = (node: MenuNode, path: number[], depth: number) => {
      (node.children ?? []).forEach((ch, i) => {
        const p = [...path, i];
        const id = pathId(p);
        const leaf = !ch.children?.length;
        out.push({id, path: p, node: ch, depth, leaf});
        if (!leaf && expanded.has(id)) walk(ch, p, depth + 1);
      });
    };
    walk(root, [], 0);
    return out;
  }, [root, expanded]);

  /** Le curseur a changé via l'arbre lui-même : bascule la branche ici. */
  const tap = (row: TreeRow) => {
    if (!row.leaf) {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
    }
    onSelect(row.path);
  };

  return (
    <View style={{borderWidth: 1, borderColor: c.border, borderRadius: 10, overflow: 'hidden'}}>
      <View style={{backgroundColor: c.bgPanel2, paddingHorizontal: 10, paddingVertical: 5}}>
        <Text style={{color: c.textDim, fontSize: 10, fontWeight: '800', letterSpacing: 1}}>
          {t.hb.treeTitle.toUpperCase()}
        </Text>
      </View>
      {rows.map((row) => {
        const selected = row.id === curId;
        return (
          <Pressable
            key={row.id}
            onPress={() => tap(row)}
            style={({pressed}) => ({
              flexDirection: 'row', alignItems: 'center',
              paddingLeft: 8 + row.depth * 15, paddingRight: 8, height: 33,
              borderTopWidth: 0.5, borderTopColor: c.border,
              backgroundColor: selected ? c.btnActive : pressed ? c.bgPanel2 : 'transparent',
            })}>
            <Text style={{width: 15, color: c.amber, fontSize: 11, fontWeight: '800'}}>
              {row.leaf ? '·' : expanded.has(row.id) ? '▾' : '▸'}
            </Text>
            <Text numberOfLines={1}
              style={{flex: 1, fontSize: 12.5, color: selected ? c.amber : c.text, fontWeight: selected ? '800' : '500'}}>
              {row.node.line1}
            </Text>
            {row.leaf && row.node.onGoto && !row.node.onEnter ? (
              <Text style={{color: c.textFaint, fontSize: 8.5, fontWeight: '800', letterSpacing: 0.5}}>
                GO TO
              </Text>
            ) : null}
          </Pressable>
        );
      })}
      {!rows.length ? (
        <Text style={{color: c.textFaint, fontSize: 11, padding: 10}}>{t.hb.treeEmpty}</Text>
      ) : null}
    </View>
  );
}

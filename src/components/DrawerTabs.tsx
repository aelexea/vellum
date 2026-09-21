/**
 * DrawerTabs — the 3-tab drawer header "Contents | Search | Notes" shared by
 * TocPanel/SearchPanel/AnnotationsPanel (§5.6). App renders those drawers standalone and
 * mutually exclusively, so each mounts this header; switching tabs goes through
 * uiStore.setOverlay. One component + one CSS block so the three drawers cannot drift.
 *
 * Styling note: base.css resets are unlayered and outrank Tailwind's `@layer utilities`,
 * so the tabs are styled by the scoped <style> block below (class selectors win on
 * specificity over the `button` element reset).
 */
import { useUiStore } from '@/stores/uiStore';

const DRAWER_TABS_CSS = `
.vel-sp-tabs{ display:flex; gap:2px; padding:0 10px; border-bottom:1px solid var(--v-border); }
.vel-sp-tab{
  position:relative; padding:11px 8px 9px; border:0; background:none;
  font-size:12px; font-weight:500; letter-spacing:.01em; cursor:pointer;
  color:var(--v-fg-muted);
  transition:color var(--dur-fast) var(--ease);
}
.vel-sp-tab:hover{ color:var(--v-fg); }
.vel-sp-tab[data-active="true"]{ color:var(--v-accent); }
.vel-sp-tab[data-active="true"]::after{
  content:""; position:absolute; left:6px; right:6px; bottom:-1px; height:2px;
  background:var(--v-accent); border-radius:2px 2px 0 0;
}
`;

export function DrawerTabs({ active }: { active: 'toc' | 'search' | 'annotations' }) {
  const setOverlay = useUiStore((s) => s.setOverlay);
  const tabs: { id: 'toc' | 'search' | 'annotations'; label: string }[] = [
    { id: 'toc', label: 'Contents' },
    { id: 'search', label: 'Search' },
    { id: 'annotations', label: 'Notes' },
  ];
  return (
    <div className="vel-sp-tabs" role="tablist" aria-label="Reading panels">
      <style>{DRAWER_TABS_CSS}</style>
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === active}
          data-active={t.id === active}
          className="vel-sp-tab"
          onClick={() => setOverlay(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export default DrawerTabs;

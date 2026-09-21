/**
 * Re-export shim — §11.6 lists the injected reader CSS at `styles/readerBaseCss.ts` [F0],
 * while §5.3 says the const is "exported from engine". Both paths resolve to the same
 * module so F0/F2 imports work regardless of which section they follow.
 */
export { readerBaseCss, readerBaseCss as default } from '@/features/reader/engine/readerBaseCss';

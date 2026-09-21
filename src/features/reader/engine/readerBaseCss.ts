/**
 * CSS injected into every chapter iframe (§5.3, §11.6). Owned by [F0].
 *
 * Every reader-adjustable property is read from a CSS custom property written by
 * pagination.applyTypography() from the typography record, so a settings change or theme switch
 * is a var write — never a re-parse of the chapter. Each such var carries a §6.6 fallback so an
 * unstyled document still reads correctly.
 *
 * Two things make this stylesheet deliberately self-contained rather than relying on the app's
 * cascade:
 *  1. The chapter is a separate document, so the frozen §5.11 `:root` tokens never reach it.
 *     The motion/shape tokens it uses are redeclared verbatim at the top.
 *  2. `--f` aliases the page foreground, because the muted-rule/border tints would otherwise
 *     repeat `color-mix(in srgb, var(--v-page-fg, #26221d) …)` seven times.
 *
 * Budget: < 4 KB (§5.3 note in the F0 spec) — this string is injected into all three pooled
 * iframes on every chapter load, so it is minified by hand and comments live here, not in it.
 */

export const readerBaseCss = `
:root{--dur-fast:120ms;--dur-med:180ms;--ease:cubic-bezier(.2,0,0,1);--radius-sm:6px;
--f:var(--v-page-fg,#26221d)}
.vellum-doc{color-scheme:light}
html.vellum-doc,body{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--v-page-bg,#fcfbf9);color:var(--f);
font-family:var(--v-font-family,serif);font-size:var(--v-font-size,19px);
font-weight:var(--v-font-weight,400);line-height:var(--v-line-height,1.65);
letter-spacing:var(--v-letter-spacing,0);text-align:var(--v-text-align,justify);
hyphens:var(--v-hyphens,auto);-webkit-hyphens:var(--v-hyphens,auto);
hyphenate-limit-chars:var(--v-hyphen-limit,6 3 3);text-rendering:optimizeLegibility;
font-variant-numeric:oldstyle-nums proportional-nums;overflow-wrap:break-word}
p{margin:0 0 var(--v-para-spacing,.6em);text-indent:var(--v-para-indent,1.2em);
orphans:2;widows:2}
p:first-of-type,p+p,h1+p,h2+p,h3+p,h4+p,h5+p,h6+p,blockquote p,td,th,pre,figcaption{text-indent:0}
h1,h2,h3,h4,h5,h6{margin:1.4em 0 .6em;line-height:1.25;font-weight:600;text-align:left;
hyphens:none;page-break-after:avoid;break-after:avoid}
h1{font-size:1.5em}h2{font-size:1.3em}h3{font-size:1.15em}h4,h5,h6{font-size:1em}
blockquote{margin:1em var(--v-quote-margin,1.6em);padding-left:.8em;font-style:italic;
border-left:2px solid color-mix(in srgb,var(--f) 22%,transparent);
color:color-mix(in srgb,var(--f) 86%,transparent)}
hr{width:30%;margin:1.6em auto;border:0;
border-top:1px solid color-mix(in srgb,var(--f) 20%,transparent)}
a{color:var(--v-page-link,#9a5b2d);text-decoration:none;cursor:pointer}
a:hover{text-decoration:underline}
sup,sub{font-size:.75em;line-height:1}
figure{margin:1em 0;text-align:center;page-break-inside:avoid;break-inside:avoid}
figcaption{font-size:.85em;margin-top:.4em;color:color-mix(in srgb,var(--f) 72%,transparent)}
img,svg,video,canvas,audio{max-width:100%;height:auto;object-fit:contain}
img{cursor:pointer}
table{display:block;max-width:100%;font-size:.9em;border-collapse:collapse;overflow-x:auto;
-webkit-overflow-scrolling:touch}
td,th{padding:.35em .6em;text-align:left;
border:1px solid color-mix(in srgb,var(--f) 18%,transparent)}
pre{margin:1em 0;padding:.7em .9em;font-family:ui-monospace,monospace;font-size:.82em;
line-height:1.5;white-space:pre-wrap;overflow-x:auto;border-radius:var(--radius-sm);
background:color-mix(in srgb,var(--f) 5%,transparent)}
code,kbd,samp{font-family:ui-monospace,monospace;font-size:.88em}
ul,ol{margin:.6em 0 1em;padding-left:1.8em}
li{margin:.25em 0;orphans:2;widows:2}
li>p{text-indent:0}
abbr[title]{border-bottom:1px dotted;cursor:help;text-decoration:none}
q{quotes:'\\201C' '\\201D' '\\2018' '\\2019'}
mark.vellum-hl{background:var(--v-hl-bg,transparent);border-radius:2px;cursor:pointer;
padding:.05em 0;color:inherit;-webkit-box-decoration-break:clone;box-decoration-break:clone}
mark.vellum-note::after{content:'\\258E';display:inline-block;margin-left:.1em;font-size:.9em;
line-height:1;color:var(--f);opacity:.65;transform:translateY(-.05em)}
mark.vellum-flash{color:inherit;padding:.05em 0;border-radius:2px;
animation:vellum-flash 1.2s var(--ease) forwards}
@keyframes vellum-flash{0%,55%{background:var(--v-accent,var(--v-page-selection,rgba(194,102,45,.5)))}
100%{background:transparent}}
::selection{background:var(--v-page-selection,rgba(194,102,45,.22));color:inherit}
mark.vellum-hl::selection{background:inherit}
img.vellum-zoomable{cursor:zoom-in}
.vellum-paginated{transition:transform var(--dur-fast) var(--ease)}
@media (prefers-reduced-motion:reduce){
mark.vellum-flash{animation:none;background:var(--v-accent,var(--v-page-selection,rgba(194,102,45,.5)))}
.vellum-paginated{transition:none}
}
`;

export default readerBaseCss;

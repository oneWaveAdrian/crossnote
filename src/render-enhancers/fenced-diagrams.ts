// tslint:disable:ban-types no-var-requires
import * as YAML from 'yaml';

import { escape } from 'html-escaper';
import * as pako from 'pako';
import computeChecksum from '../lib/compute-checksum';
import { render as renderPlantuml } from '../renderers/puml';
import { toSVG as vegaToSvg } from '../renderers/vega';
import { toSVG as vegaLiteToSvg } from '../renderers/vega-lite';
import { Viz } from '../renderers/viz';

import {
  BlockAttributes,
  stringifyBlockAttributes,
} from '../lib/block-attributes/index.js';
import { BlockInfo } from '../lib/block-info/index.js';
import { isVSCodeWebExtension } from '../utility';

const ensureClassInAttributes = (
  attributes: BlockAttributes,
  className: string,
) => {
  const existingClassNames: string = attributes['class'] || '';
  if (existingClassNames.split(' ').indexOf(className) === -1) {
    return {
      ...attributes,
      ['class']: `${existingClassNames} ${className}`.trim(),
    };
  }
};

// same order as in docs
const supportedLanguages = [
  'mermaid',
  'puml',
  'plantuml',
  'wavedrom',
  'graphviz',
  'viz',
  'dot',
  'vega',
  'vega-lite',
];

/**
 * This function resolves image paths and render code blocks
 * @param html the html string that we will analyze
 * @return html
 */
export default async function enhance({
  $,
  graphsCache,
  fileDirectoryPath,
  imageDirectoryPath,
  plantumlServer,
  plantumlJarPath,
  kirokiServer,
}: {
  $: CheerioStatic;
  graphsCache: { [key: string]: string };
  fileDirectoryPath: string;
  imageDirectoryPath: string;
  plantumlServer: string;
  plantumlJarPath: string;
  kirokiServer: string;
}): Promise<void> {
  const asyncFunctions: Promise<void>[] = [];
  $('[data-role="codeBlock"]').each((i, container) => {
    const $container = $(container);
    if ($container.data('executor')) {
      return;
    }

    const normalizedInfo: BlockInfo = $container.data('normalizedInfo');
    // Check if Kroki is enabled
    const isKroki = !!normalizedInfo.attributes['kroki'];
    if (
      normalizedInfo.attributes['literate'] === false ||
      normalizedInfo.attributes['cmd'] === false ||
      (supportedLanguages.indexOf(normalizedInfo.language) === -1 && !isKroki)
    ) {
      return;
    }

    $container.data('executor', 'fenced-diagrams');

    if (normalizedInfo.attributes['literate'] === false) {
      return;
    }

    asyncFunctions.push(
      renderDiagram({
        $container,
        normalizedInfo,
        $,
        graphsCache,
        fileDirectoryPath,
        imageDirectoryPath,
        plantumlServer,
        plantumlJarPath,
        isKroki,
        kirokiServer,
      }),
    );
  });
  await Promise.all(asyncFunctions);
}

async function renderDiagram({
  $container,
  normalizedInfo,
  $,
  graphsCache,
  fileDirectoryPath,
  plantumlServer,
  plantumlJarPath,
  isKroki,
  kirokiServer,
}: {
  $container: Cheerio;
  normalizedInfo: BlockInfo;
  $: CheerioStatic;
  graphsCache: { [key: string]: string };
  fileDirectoryPath: string;
  imageDirectoryPath: string;
  plantumlJarPath: string;
  plantumlServer: string;
  isKroki: boolean;
  kirokiServer: string;
}): Promise<void> {
  let $output: string | Cheerio | null = null;

  const code = $container.text();
  const checksum = computeChecksum(JSON.stringify(normalizedInfo) + code);
  const diagramInCache: string = graphsCache[checksum];

  if (
    isKroki ||
    // For VSCode Web Extension, we render plantuml diagrams on the kroki server
    (isVSCodeWebExtension() &&
      ['plantuml', 'puml'].includes(normalizedInfo.language))
  ) {
    if (diagramInCache) {
      $output = diagramInCache;
    } else {
      // Kroki is a service that can render diagrams from textual descriptions
      // see https://kroki.io/
      const krokiURL = kirokiServer || 'https://kroki.io';

      let krokiDiagramType =
        typeof normalizedInfo.attributes['kroki'] === 'string'
          ? normalizedInfo.attributes['kroki']
          : normalizedInfo.language;
      if (krokiDiagramType === 'puml') {
        krokiDiagramType = 'plantuml';
      }

      // Convert code to deflate+base64
      const data = Buffer.from(code, 'utf8');
      const compressed = pako.deflate(data, { level: 9 });
      const result = Buffer.from(compressed)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
      const krokiDiagramURL = `${krokiURL}/${krokiDiagramType}/${normalizedInfo
        .attributes['output'] ?? 'svg'}/${result}`;

      $output = `<div ${stringifyBlockAttributes(
        ensureClassInAttributes(
          normalizedInfo.attributes,
          normalizedInfo.language,
        ),
      )}><img src="${krokiDiagramURL}" alt="${
        normalizedInfo.language
      } diagram"></div>`;

      graphsCache[checksum] = $output; // store to new cache
    }
  } else {
    try {
      switch (normalizedInfo.language) {
        case 'mermaid': {
          // these diagrams are rendered on the client
          $output = `<div ${stringifyBlockAttributes(
            ensureClassInAttributes(
              normalizedInfo.attributes,
              normalizedInfo.language,
            ),
          )}>${escape(code)}</div>`;
          break;
        }
        case 'wavedrom': {
          // wavedrom is also rendered on the client, but using <script>
          $output = `<div ${stringifyBlockAttributes(
            ensureClassInAttributes(
              normalizedInfo.attributes,
              normalizedInfo.language,
            ),
          )}><script type="WaveDrom">${code}</script></div>`;
          break;
        }
        case 'puml':
        case 'plantuml': {
          let svg = diagramInCache;
          if (!svg) {
            svg = await renderPlantuml({
              content: code,
              fileDirectoryPath,
              serverURL: plantumlServer,
              plantumlJarPath,
            });
            graphsCache[checksum] = svg; // store to new cache
          }
          $output = `<p ${stringifyBlockAttributes(
            normalizedInfo.attributes,
          )}>${svg}</p>`;
          break;
        }
        case 'graphviz':
        case 'viz':
        case 'dot': {
          let svg = diagramInCache;
          if (!svg) {
            const engine = normalizedInfo.attributes['engine'] || 'dot';
            svg = await Viz(code, { engine });
            graphsCache[checksum] = svg; // store to new cache
          }
          $output = `<p ${stringifyBlockAttributes(
            normalizedInfo.attributes,
          )}>${svg}</p>`;
          break;
        }
        case 'vega':
        case 'vega-lite': {
          if (normalizedInfo.attributes['interactive'] === true) {
            const rawSpec = code.trim();
            let spec;
            if (rawSpec[0] !== '{') {
              // yaml
              spec = YAML.parse(rawSpec);
            } else {
              // json
              spec = JSON.parse(rawSpec);
            }
            $output = hiddenCode(
              JSON.stringify(spec).replace('<', '&lt;'),
              normalizedInfo.attributes,
              normalizedInfo.language,
            );
          } else {
            let svg = diagramInCache;
            if (!svg) {
              const vegaFunctionToCall =
                normalizedInfo.language === 'vega' ? vegaToSvg : vegaLiteToSvg;
              svg = await vegaFunctionToCall(code, fileDirectoryPath);
              graphsCache[checksum] = svg; // store to new cache
            }
            $output = `<p ${stringifyBlockAttributes(
              normalizedInfo.attributes,
            )}>${svg}</p>`;
          }
          break;
        }
      }
    } catch (error) {
      $output = $(`<pre class="language-text">${error.toString()}</pre>`);
    }
  }

  if ($output !== null) {
    normalizedInfo.attributes['output_first'] === true
      ? $container.before($output as string)
      : $container.after($output as string);
  }

  if (
    normalizedInfo.attributes['hide'] !== false &&
    normalizedInfo.attributes['code_block'] !== true
  ) {
    $container.data('hiddenByEnhancer', true);
  }
}

const hiddenCode = (code, attributes, language) =>
  `<p ${stringifyBlockAttributes(
    ensureClassInAttributes(attributes, language),
  )}><span style="display: none">${code}</span></p>`;

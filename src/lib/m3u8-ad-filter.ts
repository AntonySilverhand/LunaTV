/**
 * 移除点播 M3U8 中的插播广告。
 *
 * 采集站的广告以 #EXT-X-DISCONTINUITY 与正片隔开，分片放在与正片不同的目录下，
 * 时间戳从头开始。正片在广告前后的时间戳是连续的，因此整段删除广告后时间轴仍然完整。
 *
 * 不能只删除 #EXT-X-DISCONTINUITY：广告分片还在，播放器看不到时间戳断点，
 * 时间轴错乱后可能直接跳到片尾。并非每个 DISCONTINUITY 都是广告，部分片源每隔几十秒
 * 就有一个，所以正片之间的标记必须保留。
 */

/** 单段广告的时长上限（秒），更长的片段不视为广告 */
const MAX_AD_BLOCK_SECONDS = 120;
/** 广告占全片的比例上限，超过时认为判断不可靠，放弃过滤 */
const MAX_AD_SHARE = 0.2;

const DISCONTINUITY_TAG = '#EXT-X-DISCONTINUITY';
const ENDLIST_TAG = '#EXT-X-ENDLIST';
const EXTINF_PREFIX = '#EXTINF:';
/** 这些标签对其后的所有分片持续生效，删除所在片段时需要延续其状态 */
const STATEFUL_TAG_PREFIXES = ['#EXT-X-KEY', '#EXT-X-MAP'];

interface Block {
  lines: string[];
  duration: number;
  dirs: Set<string>;
}

function statefulPrefix(line: string): string | undefined {
  return STATEFUL_TAG_PREFIXES.find((prefix) => line.startsWith(prefix));
}

function isBlockStart(line: string): boolean {
  return (
    line === DISCONTINUITY_TAG ||
    line.startsWith(EXTINF_PREFIX) ||
    statefulPrefix(line) !== undefined
  );
}

function segmentDir(uri: string, baseUrl: string): string {
  try {
    const url = new URL(uri, baseUrl);
    return url.origin + url.pathname.slice(0, url.pathname.lastIndexOf('/'));
  } catch {
    const path = uri.split('?')[0];
    return path.slice(0, path.lastIndexOf('/') + 1);
  }
}

function parseBlocks(
  lines: string[],
  baseUrl: string
): { blocks: Block[]; dirWeights: Map<string, number>; endlist: string[] } {
  const newBlock = (): Block => ({ lines: [], duration: 0, dirs: new Set() });
  const blocks: Block[] = [];
  const dirWeights = new Map<string, number>();
  const endlist: string[] = [];
  let current = newBlock();
  let segmentDuration = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (line === DISCONTINUITY_TAG) {
      if (current.lines.length > 0) {
        blocks.push(current);
        current = newBlock();
      }
      continue;
    }
    if (line === ENDLIST_TAG) {
      endlist.push(raw);
      continue;
    }
    current.lines.push(raw);
    if (line.startsWith(EXTINF_PREFIX)) {
      segmentDuration = parseFloat(line.slice(EXTINF_PREFIX.length)) || 0;
      current.duration += segmentDuration;
    } else if (line && !line.startsWith('#')) {
      const dir = segmentDir(line, baseUrl);
      current.dirs.add(dir);
      dirWeights.set(dir, (dirWeights.get(dir) || 0) + segmentDuration);
    }
  }
  if (current.lines.length > 0) {
    blocks.push(current);
  }
  return { blocks, dirWeights, endlist };
}

/** 广告片段之后，下一段没有自行声明的状态标签需要补上，保持与原列表相同的语义 */
function carriedTagsFor(block: Block, carried: Map<string, string>): string[] {
  const declared = new Set<string>();
  for (const raw of block.lines) {
    const line = raw.trim();
    if (line.startsWith(EXTINF_PREFIX)) break;
    const prefix = statefulPrefix(line);
    if (prefix) declared.add(prefix);
  }
  return Array.from(carried.entries())
    .filter(([prefix]) => !declared.has(prefix))
    .map(([, raw]) => raw);
}

/**
 * @param content M3U8 文本，主播放列表（不含分片）会原样返回
 * @param baseUrl 播放列表地址，用于解析相对路径的分片
 * @returns 移除广告后的文本；未发现可靠的广告时返回原文
 */
export function filterAdsFromM3U8(content: string, baseUrl: string): string {
  if (!content) return '';

  const lines = content.split('\n');
  const firstBlockLine = lines.findIndex((line) => isBlockStart(line.trim()));
  if (firstBlockLine < 0) return content;

  const { blocks, dirWeights, endlist } = parseBlocks(
    lines.slice(firstBlockLine),
    baseUrl
  );
  if (blocks.length < 2 || dirWeights.size < 2) return content;

  const mainDir = Array.from(dirWeights.entries()).reduce((a, b) =>
    b[1] > a[1] ? b : a
  )[0];
  const isAd = (block: Block) =>
    block.dirs.size > 0 &&
    !block.dirs.has(mainDir) &&
    block.duration <= MAX_AD_BLOCK_SECONDS;

  const total = blocks.reduce((sum, block) => sum + block.duration, 0);
  const adTotal = blocks
    .filter(isAd)
    .reduce((sum, block) => sum + block.duration, 0);
  if (adTotal === 0 || adTotal > total * MAX_AD_SHARE) return content;

  const output = lines.slice(0, firstBlockLine);
  const carried = new Map<string, string>();
  let wroteBlock = false;

  for (const block of blocks) {
    if (isAd(block)) {
      for (const raw of block.lines) {
        const prefix = statefulPrefix(raw.trim());
        if (prefix) carried.set(prefix, raw);
      }
      continue;
    }
    if (wroteBlock) output.push(DISCONTINUITY_TAG);
    output.push(...carriedTagsFor(block, carried), ...block.lines);
    carried.clear();
    wroteBlock = true;
  }
  output.push(...endlist);

  return output.join('\n');
}

import { filterAdsFromM3U8 } from './m3u8-ad-filter';

const BASE = 'https://cdn.example.com/main/hls/index.m3u8';
const HEADER = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6'];
const DISC = '#EXT-X-DISCONTINUITY';
const END = '#EXT-X-ENDLIST';

function main(name: string, seconds = 300): string[] {
  return [`#EXTINF:${seconds},`, `${name}.ts`];
}

function ad(prefix = 'https://cdn.example.com/ad/hls'): string[] {
  return ['#EXTINF:17.6,', `${prefix}/ad.ts`];
}

function playlist(...parts: string[][]): string {
  return [...HEADER, ...parts.flat(), END].join('\n');
}

describe('filterAdsFromM3U8', () => {
  it('removes a mid-roll ad and leaves one discontinuity in its place', () => {
    const input = playlist(main('a'), [DISC], ad(), [DISC], main('b'));
    expect(filterAdsFromM3U8(input, BASE)).toBe(
      playlist(main('a'), [DISC], main('b'))
    );
  });

  it('keeps discontinuities between content blocks', () => {
    const input = playlist(
      main('a'),
      [DISC],
      main('b'),
      [DISC],
      ad(),
      [DISC],
      main('c')
    );
    expect(filterAdsFromM3U8(input, BASE)).toBe(
      playlist(main('a'), [DISC], main('b'), [DISC], main('c'))
    );
  });

  it('removes pre-roll and post-roll ads without dangling tags', () => {
    const input = playlist(
      ad('https://other.example.com/x'),
      [DISC],
      main('a'),
      [DISC],
      ad()
    );
    expect(filterAdsFromM3U8(input, BASE)).toBe(playlist(main('a')));
  });

  it('continues a METHOD=NONE key declared inside a removed ad', () => {
    const key = '#EXT-X-KEY:METHOD=NONE';
    const input = playlist(main('a'), [DISC, key], ad(), [DISC], main('b'));
    expect(filterAdsFromM3U8(input, BASE)).toBe(
      playlist(main('a'), [DISC, key], main('b'))
    );
  });

  it('does not repeat a carried key when the next block declares its own', () => {
    const none = '#EXT-X-KEY:METHOD=NONE';
    const aes = '#EXT-X-KEY:METHOD=AES-128,URI="k"';
    const input = playlist(
      [aes],
      main('a'),
      [DISC, none],
      ad(),
      [DISC, aes],
      main('b')
    );
    expect(filterAdsFromM3U8(input, BASE)).toBe(
      playlist([aes], main('a'), [DISC, aes], main('b'))
    );
  });

  it('returns the original when every block shares one directory', () => {
    const input = playlist(main('a'), [DISC], main('b', 20), [DISC], main('c'));
    expect(filterAdsFromM3U8(input, BASE)).toBe(input);
  });

  it('keeps a long block outside the main directory', () => {
    const long = ['#EXTINF:121,', 'https://cdn.example.com/other/x.ts'];
    const input = playlist(main('a', 900), [DISC], long, [DISC], main('b', 900));
    expect(filterAdsFromM3U8(input, BASE)).toBe(input);
  });

  it('gives up when removal would exceed the safety share', () => {
    const input = playlist(main('a', 30), [DISC], ad(), [DISC], main('b', 30));
    expect(filterAdsFromM3U8(input, BASE)).toBe(input);
  });

  it('leaves master playlists untouched', () => {
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmid/index.m3u8';
    expect(filterAdsFromM3U8(master, BASE)).toBe(master);
  });

  it('returns an empty string for empty input', () => {
    expect(filterAdsFromM3U8('', BASE)).toBe('');
  });
});

interface CaseFoldRange {
  readonly start: number;
  readonly end: number;
  readonly step: number;
  readonly delta: number;
}

// Unicode 17.0 CaseFolding.txt の C+F を、等差 range と例外 mapping に圧縮した共有固定表。
const CASE_FOLD_RANGE_DATA = `
41,5a,1,20;c0,d6,1,20;d8,de,1,20;100,12e,2,1;132,136,2,1;139,147,2,1;14a,176,2,1;179,17d,2,1;182,184,2,1;189,18a,1,cd
1a0,1a4,2,1;1b1,1b2,1,d9;1b3,1b5,2,1;1cb,1db,2,1;1de,1ee,2,1;1f2,1f4,2,1;1f8,21e,2,1;222,232,2,1;246,24e,2,1;370,372,2,1
388,38a,1,25;38e,38f,1,3f;391,3a1,1,20;3a3,3ab,1,20;3d8,3ee,2,1;3fd,3ff,1,-82;400,40f,1,50;410,42f,1,20;460,480,2,1;48a,4be,2,1
4c1,4cd,2,1;4d0,52e,2,1;531,556,1,30;10a0,10c5,1,1c60;13f8,13fd,1,-8;1c83,1c84,1,-1842;1c90,1cba,1,-bc0;1cbd,1cbf,1,-bc0
1e00,1e94,2,1;1ea0,1efe,2,1;1f08,1f0f,1,-8;1f18,1f1d,1,-8;1f28,1f2f,1,-8;1f38,1f3f,1,-8;1f48,1f4d,1,-8;1f59,1f5f,2,-8
1f68,1f6f,1,-8;1fb8,1fb9,1,-8;1fba,1fbb,1,-4a;1fc8,1fcb,1,-56;1fd8,1fd9,1,-8;1fda,1fdb,1,-64;1fe8,1fe9,1,-8;1fea,1feb,1,-70
1ff8,1ff9,1,-80;1ffa,1ffb,1,-7e;2160,216f,1,10;24b6,24cf,1,1a;2c00,2c2f,1,30;2c67,2c6b,2,1;2c7e,2c7f,1,-2a3f;2c80,2ce2,2,1
2ceb,2ced,2,1;a640,a66c,2,1;a680,a69a,2,1;a722,a72e,2,1;a732,a76e,2,1;a779,a77b,2,1;a77e,a786,2,1;a790,a792,2,1;a796,a7a8,2,1
a7b4,a7c2,2,1;a7c7,a7c9,2,1;a7cc,a7da,2,1;ab70,abbf,1,-97d0;ff21,ff3a,1,20;10400,10427,1,28;104b0,104d3,1,28;10570,1057a,1,27
1057c,1058a,1,27;1058c,10592,1,27;10594,10595,1,27;10c80,10cb2,1,40;10d50,10d65,1,20;118a0,118bf,1,20;16e40,16e5f,1,20
16ea0,16eb8,1,1b;1e900,1e921,1,22
`;

const CASE_FOLD_MAPPING_DATA = `
b5=3bc;178=ff;17f=73;181=253;186=254;187=188;18b=18c;18e=1dd;18f=259;190=25b;191=192;193=260;194=263;196=269;197=268;198=199
19c=26f;19d=272;19f=275;1a6=280;1a7=1a8;1a9=283;1ac=1ad;1ae=288;1af=1b0;1b7=292;1b8=1b9;1bc=1bd;1c4=1c6;1c5=1c6;1c7=1c9
1c8=1c9;1ca=1cc;1f1=1f3;1f6=195;1f7=1bf;220=19e;23a=2c65;23b=23c;23d=19a;23e=2c66;241=242;243=180;244=289;245=28c;345=3b9
376=377;37f=3f3;386=3ac;38c=3cc;3c2=3c3;3cf=3d7;3d0=3b2;3d1=3b8;3d5=3c6;3d6=3c0;3f0=3ba;3f1=3c1;3f4=3b8;3f5=3b5
3f7=3f8;3f9=3f2;3fa=3fb;4c0=4cf;10c7=2d27;10cd=2d2d;1c80=432;1c81=434;1c82=43e;1c85=442;1c86=44a;1c87=463;1c88=a64b
1c89=1c8a;1e9b=1e61;1fbe=3b9;1fec=1fe5;2126=3c9;212a=6b;212b=e5;2132=214e;2183=2184;2c60=2c61;2c62=26b;2c63=1d7d
2c64=27d;2c6d=251;2c6e=271;2c6f=250;2c70=252;2c72=2c73;2c75=2c76;2cf2=2cf3;a77d=1d79;a78b=a78c;a78d=265;a7aa=266;a7ab=25c
a7ac=261;a7ad=26c;a7ae=26a;a7b0=29e;a7b1=287;a7b2=29d;a7b3=ab53;a7c4=a794;a7c5=282;a7c6=1d8e;a7cb=264;a7dc=19b;a7f5=a7f6
df=73,73;130=69,307;149=2bc,6e;1f0=6a,30c;390=3b9,308,301;3b0=3c5,308,301;587=565,582;1e96=68,331;1e97=74,308
1e98=77,30a;1e99=79,30a;1e9a=61,2be;1e9e=73,73;1f50=3c5,313;1f52=3c5,313,300;1f54=3c5,313,301;1f56=3c5,313,342
1f80=1f00,3b9;1f81=1f01,3b9;1f82=1f02,3b9;1f83=1f03,3b9;1f84=1f04,3b9;1f85=1f05,3b9;1f86=1f06,3b9;1f87=1f07,3b9
1f88=1f00,3b9;1f89=1f01,3b9;1f8a=1f02,3b9;1f8b=1f03,3b9;1f8c=1f04,3b9;1f8d=1f05,3b9;1f8e=1f06,3b9;1f8f=1f07,3b9
1f90=1f20,3b9;1f91=1f21,3b9;1f92=1f22,3b9;1f93=1f23,3b9;1f94=1f24,3b9;1f95=1f25,3b9;1f96=1f26,3b9;1f97=1f27,3b9
1f98=1f20,3b9;1f99=1f21,3b9;1f9a=1f22,3b9;1f9b=1f23,3b9;1f9c=1f24,3b9;1f9d=1f25,3b9;1f9e=1f26,3b9;1f9f=1f27,3b9
1fa0=1f60,3b9;1fa1=1f61,3b9;1fa2=1f62,3b9;1fa3=1f63,3b9;1fa4=1f64,3b9;1fa5=1f65,3b9;1fa6=1f66,3b9;1fa7=1f67,3b9
1fa8=1f60,3b9;1fa9=1f61,3b9;1faa=1f62,3b9;1fab=1f63,3b9;1fac=1f64,3b9;1fad=1f65,3b9;1fae=1f66,3b9;1faf=1f67,3b9
1fb2=1f70,3b9;1fb3=3b1,3b9;1fb4=3ac,3b9;1fb6=3b1,342;1fb7=3b1,342,3b9;1fbc=3b1,3b9;1fc2=1f74,3b9;1fc3=3b7,3b9
1fc4=3ae,3b9;1fc6=3b7,342;1fc7=3b7,342,3b9;1fcc=3b7,3b9;1fd2=3b9,308,300;1fd3=3b9,308,301;1fd6=3b9,342
1fd7=3b9,308,342;1fe2=3c5,308,300;1fe3=3c5,308,301;1fe4=3c1,313;1fe6=3c5,342;1fe7=3c5,308,342;1ff2=1f7c,3b9
1ff3=3c9,3b9;1ff4=3ce,3b9;1ff6=3c9,342;1ff7=3c9,342,3b9;1ffc=3c9,3b9;fb00=66,66;fb01=66,69;fb02=66,6c
fb03=66,66,69;fb04=66,66,6c;fb05=73,74;fb06=73,74;fb13=574,576;fb14=574,565;fb15=574,56b;fb16=57e,576;fb17=574,56d
`;

function parseHex(value: string): number {
  const sign = value.startsWith('-') ? -1 : 1;
  const digits = sign === -1 ? value.slice(1) : value;
  return sign * Number.parseInt(digits, 16);
}

function parseRanges(data: string): CaseFoldRange[] {
  return data.trim().split(/\s*;\s*|\s+/).map((entry) => {
    const [start, end, step, delta] = entry.split(',').map(parseHex);
    return { start: start!, end: end!, step: step!, delta: delta! };
  });
}

function buildCaseFoldMappings(): ReadonlyMap<number, string> {
  const mappings = new Map<number, string>();
  for (const range of parseRanges(CASE_FOLD_RANGE_DATA)) {
    for (let codePoint = range.start; codePoint <= range.end; codePoint += range.step) {
      mappings.set(codePoint, String.fromCodePoint(codePoint + range.delta));
    }
  }
  for (const entry of CASE_FOLD_MAPPING_DATA.trim().split(/\s*;\s*|\s+/)) {
    const [source, targets] = entry.split('=');
    mappings.set(
      parseHex(source!),
      String.fromCodePoint(...targets!.split(',').map(parseHex)),
    );
  }
  return mappings;
}

const CASE_FOLD_MAPPINGS = buildCaseFoldMappings();

/**
 * Unicode 17.0 Default Case Folding（CaseFolding.txt の C+F、Turkic T は除外）
 * を NFC の前後に適用し、portable identity の正規形を1つに固定する。
 */
export function unicodeDefaultCaseFoldNfc(value: string): string {
  return [...value.normalize('NFC')]
    .map((character) => (
      CASE_FOLD_MAPPINGS.get(character.codePointAt(0)!) ?? character
    ))
    .join('')
    .normalize('NFC');
}

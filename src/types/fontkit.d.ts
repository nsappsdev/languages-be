declare module 'fontkit' {
  export function create(bytes: Buffer): {
    familyName: string; subfamilyName: string; postscriptName: string;
    unitsPerEm: number; numGlyphs: number;
    hasGlyphForCodePoint(code: number): boolean;
    glyphForCodePoint(code: number): { path: unknown };
  };
}

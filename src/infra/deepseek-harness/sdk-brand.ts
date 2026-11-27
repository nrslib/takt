declare const BRAND: unique symbol;

export type Branded<B extends string> = string & {
  readonly [BRAND]: B;
};

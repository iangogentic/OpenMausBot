declare module "saxen" {
  type Handler = (...args: any[]) => void;
  export class Parser {
    constructor(options?: { proxy?: boolean });
    on(event: string, handler: Handler): this;
    parse(xml: string): void | Error;
  }
}

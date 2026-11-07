// Swift sources are imported as text (Bun `with { type: "text" }`) and embedded in the binary.
declare module "*.swift" {
  const source: string;
  export default source;
}

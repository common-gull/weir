// A tiny relocatable step module used by workflows/example.ts. Taking its `name` as an explicit
// argument (not a lexical capture) is the same discipline weir's container runtime enforces across a
// process boundary; the example passes it in and wraps the call in a host closure.
export default ({ name }: { name: string }) => `hello, ${name}`;

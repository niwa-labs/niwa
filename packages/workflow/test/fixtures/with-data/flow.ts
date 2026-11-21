import table from "./table.json";
export default workflow({ output: z.number() }, async () => table.n);

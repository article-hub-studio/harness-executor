// types.js — kiểu dữ liệu chung (JSDoc). Tham chiếu docs/SPEC.md §3

/** @typedef {{name:string, description:string, inputSchema:object}} McpTool */
/** @typedef {{id:string,name:string,category:string,description:string,version:string,
 * author:string,icon:string,transport:'builtin'|'stdio'|'http',command?:string,args?:string[],
 * url?:string,tags:string[],stars:number,tools:McpTool[]}} McpDescriptor */
/** @typedef {{id:string,name:string,category:string,version:string,description:string,icon:string,
 * permissions:string[],hooks:string[],enabled:boolean,popularity:number}} Plugin */
/** @typedef {{type:'model'|'tool'|'note',prompt?:string,server?:string,tool?:string,
 * argsTemplate?:object}} SkillStep */
/** @typedef {{id:string,name:string,description:string,icon:string,tags:string[],
 * inputs:{key:string,label:string,placeholder?:string}[],steps:SkillStep[]}} Skill */
/** @typedef {{ok:boolean,result?:any,error?:string,
 * meta:{server:string,tool:string,durationMs:number,mocked:boolean}}} ToolResult */
export {};

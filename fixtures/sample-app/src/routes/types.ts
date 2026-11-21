export interface RouteDefinition {
  method: "GET" | "POST" | "DELETE";
  path: string;
  handler: string;
}

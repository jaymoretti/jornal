import { handleArticle } from "./api/article";
import { handleFeed } from "./api/feed";

export default {
  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api/feed") return handleFeed(request);
    if (pathname === "/api/article") return handleArticle(request);
    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  },
};

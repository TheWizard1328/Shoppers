export default async function handler(req: Request): Promise<Response> {
  const body = "<html><head><script>window.close();</script></head><body></body></html>";
  return new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });
}

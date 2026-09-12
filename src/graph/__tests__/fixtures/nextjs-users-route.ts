export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return Response.json({ id: await params.then((p) => p.id) });
}

export async function POST(request: Request): Promise<Response> {
  return Response.json({ created: true });
}

function helper(): string {
  return "not a handler";
}

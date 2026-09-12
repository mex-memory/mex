export const DELETE = async () => {
  return new Response(null, { status: 204 });
};

export function HEAD() {
  return new Response(null);
}

export async function POST(): Promise<Response> {
  return Response.json(
    { stopping: false, error: "Esta actualización corre en el equipo que barre los activos." },
    { status: 409 },
  );
}

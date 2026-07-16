// Dynamic module route (/inbox, /contacts, /analytics, /settings, …). Placeholder only —
// real screens are assembled in Phase 9 (S4) behind the data-access interface.
export default async function ModulePage({
  params,
}: {
  params: Promise<{ module: string }>;
}) {
  const { module } = await params;
  const title = module.charAt(0).toUpperCase() + module.slice(1);

  return (
    <div className="space-y-2">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">Placeholder for the {title} module.</p>
    </div>
  );
}

import { Suspense } from "react";
import { FactChecker } from "@/components/FactChecker";

export default function Page() {
  return (
    <Suspense>
      <FactChecker />
    </Suspense>
  );
}

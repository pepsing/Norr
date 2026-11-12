import { createContext } from "react";
import type { WorkspaceState } from "./workspace";

export const WorkspaceContext = createContext<WorkspaceState | null>(null);

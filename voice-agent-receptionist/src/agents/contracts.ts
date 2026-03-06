import {
  CancelAppointmentArgs,
  CreateAppointmentArgs,
  ListAvailabilityArgs,
  RescheduleAppointmentArgs
} from "../tools/calendar";

export type BusinessAgentId =
  | "dotty_intake"
  | "scheduling"
  | "quote_followup"
  | "callback_ops"
  | "manager";

export interface AgentDescriptor {
  id: BusinessAgentId;
  name: string;
  purpose: string;
  owns: string[];
}

export interface ManagedCreateAppointmentInput {
  sessionId?: number;
  args: CreateAppointmentArgs;
}

export interface ManagedRescheduleInput {
  sessionId?: number;
  args: RescheduleAppointmentArgs;
}

export interface ManagedCancelInput {
  sessionId?: number;
  args: CancelAppointmentArgs;
}

export interface ManagedFollowUpInput {
  sessionId?: number;
  callbackPhone?: string;
  note: string;
  details: Record<string, unknown>;
  assignee?: string;
}

export interface ManagedAvailabilityInput {
  sessionId?: number;
  args: ListAvailabilityArgs;
}


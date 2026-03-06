import {
  CancelAppointmentArgs,
  CreateAppointmentArgs,
  ListAvailabilityArgs,
  LocalCalendarTool,
  RescheduleAppointmentArgs
} from "../../tools/calendar";
import { AppointmentRecord, SqliteLogger } from "../../tools/logging";
import { AgentDescriptor } from "../contracts";

export class SchedulingAgent {
  readonly descriptor: AgentDescriptor = {
    id: "scheduling",
    name: "Scheduling Agent",
    purpose: "Owns calendar reads/writes and enforces no double-booking rules.",
    owns: ["availability", "bookings", "reschedules", "cancellations"]
  };

  constructor(
    private readonly calendar: LocalCalendarTool,
    private readonly db: SqliteLogger
  ) {}

  listAvailability(args: ListAvailabilityArgs) {
    return this.calendar.listAvailability(args);
  }

  createAppointment(args: CreateAppointmentArgs) {
    return this.calendar.createAppointment(args);
  }

  cancelAppointment(args: CancelAppointmentArgs) {
    return this.calendar.cancelAppointment(args);
  }

  rescheduleAppointment(args: RescheduleAppointmentArgs) {
    return this.calendar.rescheduleAppointment(args);
  }

  getAppointmentById(appointmentId: number): AppointmentRecord | null {
    return this.db.getAppointmentById(appointmentId);
  }
}


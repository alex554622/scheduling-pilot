/** Spanish for belonging to several companies: the switcher, My companies, membership requests. See `@/lib/i18n`. */
export const companies: Record<string, string> = {
  // Switcher
  "Switch company": "Cambiar de empresa",
  "Your companies": "Tus empresas",
  "Unread notifications in another company": "Notificaciones sin leer en otra empresa",
  "Join another company": "Unirse a otra empresa",
  Supervisor: "Supervisor",

  // Settings → My companies
  "My companies": "Mis empresas",
  "Each company keeps its own role, schedule, time cards and time off. Switch between them from the menu at the top.":
    "Cada empresa tiene su propio rol, horario, tarjetas de tiempo y tiempo libre. Cambia entre ellas desde el menú de arriba.",
  "You don't belong to a company yet.": "Todavía no perteneces a ninguna empresa.",
  Current: "Actual",
  Switch: "Cambiar",
  Leave: "Salir",
  "Leave {name}? You lose access to its schedule, time cards and time off. Your account and your other companies stay as they are.":
    "¿Salir de {name}? Pierdes el acceso a su horario, tarjetas de tiempo y tiempo libre. Tu cuenta y tus otras empresas siguen igual.",
  "You left the company.": "Saliste de la empresa.",
  "Enter the company code an admin gave you. The code only sends a request — an admin of that company has to approve it.":
    "Escribe el código de empresa que te dio un administrador. El código solo envía una solicitud: un administrador de esa empresa tiene que aprobarla.",
  "Find company": "Buscar empresa",
  "That company code is not valid.": "Ese código de empresa no es válido.",
  "You are already a member of this company.": "Ya eres miembro de esta empresa.",
  "Your membership in this company is suspended. Ask one of its admins.":
    "Tu membresía en esta empresa está suspendida. Habla con uno de sus administradores.",
  "Your request is already waiting for approval.": "Tu solicitud ya está esperando aprobación.",
  "Message for the admins (optional)": "Mensaje para los administradores (opcional)",
  "Who you are, which team you work in…": "Quién eres, en qué equipo trabajas…",
  "Send join request": "Enviar solicitud",
  "Request sent to {name}. An admin there has to approve it.":
    "Solicitud enviada a {name}. Un administrador de allí tiene que aprobarla.",
  "Your join requests": "Tus solicitudes",
  "Sent {date}": "Enviada el {date}",
  "Waiting for approval": "Esperando aprobación",
  Declined: "Rechazada",
  "Cancel request": "Cancelar solicitud",

  // Membership requests (admins)
  "Membership requests": "Solicitudes de membresía",
  "People who asked to join {company} with its company code. Nobody gets in until an admin approves.":
    "Personas que pidieron unirse a {company} con su código de empresa. Nadie entra hasta que un administrador lo apruebe.",
  "Asked {date}": "Pidió el {date}",
  Withdrawn: "Retirada",
  "Recently answered": "Respondidas recientemente",
  "Approve {name}": "Aprobar a {name}",
  "Decline {name}": "Rechazar a {name}",
  "Choose what they can do here. You can change it later on the Employees page.":
    "Elige lo que puede hacer aquí. Puedes cambiarlo después en la página de Empleados.",
  "They will be told the request was declined. They can ask again later.":
    "Se le avisará que la solicitud fue rechazada. Puede volver a pedirlo más tarde.",
  "Admins can see everyone's schedule and time cards and change company settings.":
    "Los administradores ven el horario y las tarjetas de tiempo de todos y cambian la configuración de la empresa.",
  Department: "Departamento",
  "No department": "Sin departamento",
  "No position": "Sin puesto",
  "Note to them (optional)": "Nota para la persona (opcional)",
  "{name} can now use this company.": "{name} ya puede usar esta empresa.",
  They: "La persona",
  "Request declined.": "Solicitud rechazada.",
  "Share it with people who should work here. They enter it under Settings → My companies.":
    "Compártelo con quienes deban trabajar aquí. Lo escriben en Configuración → Mis empresas.",
  "Code copied.": "Código copiado.",
  "Make a new code? The current code stops working right away.":
    "¿Crear un código nuevo? El código actual deja de funcionar de inmediato.",
  "New code made. The old one no longer works.": "Código nuevo creado. El anterior ya no funciona.",
  "Accept join requests": "Aceptar solicitudes",
  "When off, the code is not accepted and nobody can ask to join.":
    "Si está desactivado, el código no se acepta y nadie puede pedir unirse.",
  "Members can leave on their own": "Los miembros pueden salir por su cuenta",
  "When off, only an admin can remove someone from the company.":
    "Si está desactivado, solo un administrador puede quitar a alguien de la empresa.",

  // Suspending
  "Suspend access to this company": "Suspender el acceso a esta empresa",
  "Suspend {name}? They lose access to {companyName} right away. Their other companies are not affected.":
    "¿Suspender a {name}? Pierde el acceso a {companyName} de inmediato. Sus otras empresas no se ven afectadas.",
  "this member": "este miembro",
  "No access since {date}": "Sin acceso desde el {date}",
  Reinstate: "Restablecer",
  "Your other companies": "Tus otras empresas",
  "Access suspended": "Acceso suspendido",
  "Your access to {names} is suspended. Ask one of its admins to reinstate you.":
    "Tu acceso a {names} está suspendido. Pide a uno de sus administradores que te lo restablezca.",
};

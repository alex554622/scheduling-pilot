/** Spanish for the people screens (employees, organization, rules, reports), keyed by the English text. See `@/lib/i18n`. */
export const people: Record<string, string> = {
  // Shared
  "Loading…": "Cargando…",
  "You don't have access to this page.": "No tienes acceso a esta página.",
  Save: "Guardar",
  Cancel: "Cancelar",
  Saved: "Guardado",
  "Saved.": "Guardado.",
  Edit: "Editar",
  Add: "Agregar",
  Name: "Nombre",
  Description: "Descripción",
  Position: "Puesto",
  Positions: "Puestos",
  Status: "Estado",
  Email: "Correo electrónico",
  Role: "Rol",
  Team: "Equipo",
  Active: "Activo",
  Inactive: "Inactivo",
  Pending: "Pendiente",
  Approve: "Aprobar",
  Reject: "Rechazar",
  Employee: "Empleado",
  Employees: "Empleados",
  Organization: "Organización",
  Unnamed: "Sin nombre",
  "Unnamed user": "Usuario sin nombre",
  "Join a company first.": "Primero únete a una empresa.",
  "Not authenticated": "No has iniciado sesión",
  "Edit {name}": "Editar {name}",
  "Delete {name}": "Eliminar {name}",
  Latitude: "Latitud",
  Longitude: "Longitud",
  Address: "Dirección",
  "Use my current location": "Usar mi ubicación actual",
  Sunday: "Domingo",
  Monday: "Lunes",
  Tuesday: "Martes",
  Wednesday: "Miércoles",
  Thursday: "Jueves",
  Friday: "Viernes",
  Saturday: "Sábado",

  // Employees
  "You need to belong to a company before managing employees.":
    "Debes pertenecer a una empresa antes de administrar empleados.",
  "Manage the roster and assign roles for {companyName}.":
    "Administra la lista de personal y asigna roles en {companyName}.",
  "Join code:": "Código de unión:",
  "Join code available once your company is approved":
    "El código de unión estará disponible cuando se apruebe tu empresa",
  Copied: "Copiado",
  "Copy join code": "Copiar código de unión",
  "Join requests": "Solicitudes de unión",
  "Invite teammate": "Invitar a un compañero",
  "Total members": "Total de miembros",
  Admins: "Administradores",
  "Search by name or position…": "Buscar por nombre o puesto…",
  "Loading roster…": "Cargando lista de personal…",
  "No matches.": "Sin coincidencias.",
  "No members yet. Share your company ID so teammates can join.":
    "Aún no hay miembros. Comparte el ID de tu empresa para que tus compañeros se unan.",
  "No position set": "Sin puesto asignado",
  "Remove {name}": "Quitar a {name}",
  member: "miembro",
  "This removes them from {companyName} and frees their seat. Their account is kept, so you can rehire them later, and they can join another company with that company's join code.":
    "Esto los quita de {companyName} y libera su lugar. Su cuenta se conserva, así que puedes volver a contratarlos después, y pueden unirse a otra empresa con el código de unión de esa empresa.",
  Reason: "Motivo",
  Note: "Nota",
  "Optional context for the record": "Contexto opcional para el registro",
  "Remove from company": "Quitar de la empresa",
  "Eligible for rehire": "Elegible para recontratación",
  "Left in good standing — can be brought back.":
    "Se fue en buenos términos — se puede volver a contratar.",
  "Laid off": "Despedido por recorte",
  "Position ended. Still eligible to return.":
    "El puesto terminó. Aún puede regresar.",
  Other: "Otro",
  "Record the reason in the note below.": "Anota el motivo en la nota de abajo.",
  "Former employees": "Exempleados",
  "left {date}": "se fue el {date}",
  "Rehire {name} into {companyName}?": "¿Volver a contratar a {name} en {companyName}?",
  "this person": "esta persona",
  Rehire: "Recontratar",
  "Delete {name} from {companyName} for good?\n\nThey leave this list and can no longer be rehired with one click. Their own account stays, and they can join again with the company code. This cannot be undone.":
    "¿Eliminar a {name} de {companyName} de forma definitiva?\n\nSaldrá de esta lista y ya no se podrá volver a contratar con un clic. Su propia cuenta se conserva y puede unirse de nuevo con el código de la empresa. Esto no se puede deshacer.",
  "Delete permanently": "Eliminar definitivamente",
  "Pending invitations": "Invitaciones pendientes",
  "You're invited to join {companyName}": "Te invitaron a unirte a {companyName}",
  "You've been invited to join {companyName} as {role}.\n\nAccept your invitation:\n{url}\n\nThis link expires on {date}.":
    "Te invitaron a unirte a {companyName} como {role}.\n\nAcepta tu invitación:\n{url}\n\nEste enlace vence el {date}.",
  "You've been invited to join {companyName} as {role}.\n\nAccept your invitation:\n{url}":
    "Te invitaron a unirte a {companyName} como {role}.\n\nAcepta tu invitación:\n{url}",
  Expired: "Vencida",
  "Expires {date}": "Vence el {date}",
  "Copy link": "Copiar enlace",
  "Extend expiration by 14 days": "Extender el vencimiento 14 días",
  Extend: "Extender",
  "Regenerate the invite link for {email}? The previous link will stop working.":
    "¿Regenerar el enlace de invitación para {email}? El enlace anterior dejará de funcionar.",
  "Generate a new link and reset expiration":
    "Generar un enlace nuevo y reiniciar el vencimiento",
  Regenerate: "Regenerar",
  "Revoke invitation to {email}?": "¿Revocar la invitación para {email}?",
  "Enter a valid email address.": "Ingresa un correo electrónico válido.",
  "There is already a pending invitation for this email.":
    "Ya hay una invitación pendiente para este correo.",
  "Invitation ready": "Invitación lista",
  "Invite a teammate": "Invitar a un compañero",
  "Share the join link below with your teammate. It expires in 14 days.":
    "Comparte el enlace de abajo con tu compañero. Vence en 14 días.",
  "We'll create a join link with their role pre-assigned.":
    "Crearemos un enlace de unión con su rol ya asignado.",
  Recipient: "Destinatario",
  "Join link": "Enlace de unión",
  "Open email": "Abrir correo",
  "Create invitation": "Crear invitación",
  "Edit member": "Editar miembro",
  "Name, scheduling limits, qualifications and work locations. Roles are managed from the roster.":
    "Nombre, límites de horario, calificaciones y ubicaciones de trabajo. Los roles se administran desde la lista de personal.",
  "Full name": "Nombre completo",
  "Job title": "Puesto de trabajo",
  "e.g. Barista, Shift Lead": "p. ej. Barista, Líder de turno",
  "— no team —": "— sin equipo —",
  "No teams yet — add them on Organization → Departments.":
    "Aún no hay equipos — agrégalos en Organización → Departamentos.",
  "The schedule builder can divide its rows under each team.":
    "El creador de horarios puede dividir sus filas bajo cada equipo.",
  "Max weekly hours": "Máximo de horas por semana",
  "Qualified positions": "Puestos calificados",
  "No positions defined yet — add them under Organization → Positions.":
    "Aún no hay puestos definidos — agrégalos en Organización → Puestos.",
  "The schedule builder warns when someone is assigned a position they aren’t marked for.":
    "El creador de horarios avisa cuando se asigna a alguien un puesto para el que no está calificado.",
  "Work locations": "Ubicaciones de trabajo",
  "No locations yet — add them under Organization → Locations.":
    "Aún no hay ubicaciones — agrégalas en Organización → Ubicaciones.",
  "Their hours on the timecard are split by the location each shift was worked at.":
    "Sus horas en la tarjeta de tiempo se dividen según la ubicación donde trabajó cada turno.",
  "Pending join requests": "Solicitudes de unión pendientes",
  "Requested to join": "Solicitó unirse",

  // Join requests page
  "Back to employees": "Volver a empleados",
  "People who signed up with {company}'s join code ({code}). Approve to add them as employees.":
    "Personas que se registraron con el código de unión de {company} ({code}). Aprueba para agregarlas como empleados.",
  "People who signed up with {company}'s join code. Approve to add them as employees.":
    "Personas que se registraron con el código de unión de {company}. Aprueba para agregarlas como empleados.",
  "your company": "tu empresa",
  "No pending join requests.": "No hay solicitudes de unión pendientes.",

  // Organization
  "Departments, job positions, worksites, and reusable shift templates for {name}.":
    "Departamentos, puestos de trabajo, lugares de trabajo y plantillas de turno reutilizables para {name}.",
  General: "General",
  Departments: "Departamentos",
  Locations: "Ubicaciones",
  "Shift templates": "Plantillas de turno",
  "Scheduling timezone": "Zona horaria del horario",
  "Used to match shifts against stated availability and weekly hour totals.":
    "Se usa para comparar los turnos con la disponibilidad indicada y los totales de horas semanales.",
  Timezone: "Zona horaria",
  "(this device)": "(este dispositivo)",
  "This device reports": "Este dispositivo indica",
  "Leaving this on UTC while your team works in another zone makes ordinary day shifts look like they cross midnight.":
    "Dejarlo en UTC mientras tu equipo trabaja en otra zona hace que los turnos normales de día parezcan cruzar la medianoche.",
  "Save timezone": "Guardar zona horaria",
  "Organization name can't be empty": "El nombre de la organización no puede estar vacío",
  "Organization name must be 120 characters or fewer":
    "El nombre de la organización debe tener 120 caracteres o menos",
  "Organization name": "Nombre de la organización",
  "Shown to your team across the app, on schedules you publish, and on printed timecards.":
    "Se muestra a tu equipo en toda la aplicación, en los horarios que publicas y en las tarjetas de tiempo impresas.",
  "e.g. City of Calexico": "p. ej. Ciudad de Calexico",
  "Save name": "Guardar nombre",
  "Group employees and shifts by team.": "Agrupa empleados y turnos por equipo.",
  "Add department": "Agregar departamento",
  "No departments yet.": "Aún no hay departamentos.",
  "Edit department": "Editar departamento",
  "New department": "Nuevo departamento",
  "e.g. Front of House": "p. ej. Atención al público",
  "Job positions": "Puestos de trabajo",
  "Roles employees can be qualified for. The scheduler warns when someone isn't qualified.":
    "Funciones para las que los empleados pueden estar calificados. El planificador avisa cuando alguien no está calificado.",
  "Add position": "Agregar puesto",
  "No positions yet.": "Aún no hay puestos.",
  "Edit position": "Editar puesto",
  "New position": "Nuevo puesto",
  "Give the location a name.": "Ponle un nombre a la ubicación.",
  "New location": "Nueva ubicación",
  "Click the map to place this location's pin.":
    "Haz clic en el mapa para colocar el marcador de esta ubicación.",
  "Select or add a location to place its pin.":
    "Selecciona o agrega una ubicación para colocar su marcador.",
  "Map data © OpenStreetMap contributors — rendered with Leaflet.":
    "Datos del mapa © colaboradores de OpenStreetMap — generado con Leaflet.",
  "Each site can carry its own geofence radius.":
    "Cada lugar puede tener su propio radio de geocerca.",
  "e.g. North Yard": "p. ej. Patio norte",
  "Geofence radius:": "Radio de geocerca:",
  "No locations yet.": "Aún no hay ubicaciones.",
  "No pin set": "Sin marcador",
  "Give the template a name.": "Ponle un nombre a la plantilla.",
  "Reusable start/end times you can apply when building a schedule.":
    "Horas de inicio y fin reutilizables que puedes aplicar al crear un horario.",
  "Add template": "Agregar plantilla",
  "No templates yet.": "Aún no hay plantillas.",
  "{n}m break": "{n} min de descanso",
  "needs {n}": "requiere {n}",
  "Edit template": "Editar plantilla",
  "New shift template": "Nueva plantilla de turno",
  "Times are the site's local wall-clock times.":
    "Las horas son la hora local del lugar.",
  "e.g. Day Shift": "p. ej. Turno de día",
  Starts: "Inicia",
  Ends: "Termina",
  "Break (minutes)": "Descanso (minutos)",
  "People needed": "Personas requeridas",
  "— none —": "— ninguno —",

  // App rules
  "Admin only": "Solo administradores",
  "Only company admins can manage app rules. Contact your administrator if you need a change.":
    "Solo los administradores de la empresa pueden gestionar las reglas de la aplicación. Contacta a tu administrador si necesitas un cambio.",
  "Back to Dashboard": "Volver al panel",
  "App rules": "Reglas de la aplicación",
  "Admin-only controls for timecards, clock-in behavior, and scheduling across {company}.":
    "Controles solo para administradores sobre tarjetas de tiempo, registro de entrada y horarios en {company}.",
  "Loading settings…": "Cargando configuración…",
  "Timecard rules": "Reglas de tarjetas de tiempo",
  Overtime: "Horas extra",
  "Daily rules apply first; the weekly threshold then promotes whatever regular hours are left, so a long day is never counted twice. Any field set to 0 turns that rule off.":
    "Primero se aplican las reglas diarias; después el límite semanal convierte las horas regulares que queden, así un día largo nunca se cuenta dos veces. Cualquier campo en 0 desactiva esa regla.",
  "Punch rounding": "Redondeo de registros",
  "Clock-in, clock-out and break punches all read to the nearest mark, and hours are paid from those times. On a 5-minute rule 2:23 reads 2:25 and 2:22 reads 2:20; on a 10-minute rule 2:23 reads 2:20. The punch the clock recorded is never changed — a manager editing a day still sees the real time.":
    "Los registros de entrada, salida y descanso se leen a la marca más cercana, y las horas se pagan a partir de esas horas. Con la regla de 5 minutos, 2:23 se lee 2:25 y 2:22 se lee 2:20; con la de 10 minutos, 2:23 se lee 2:20. El registro que guardó el reloj nunca se modifica — un gerente que edite un día sigue viendo la hora real.",
  "Currently set to {n} minutes. Picking one of the options above replaces it.":
    "Actualmente está en {n} minutos. Elegir una de las opciones de arriba lo reemplaza.",
  "Clock-in rules": "Reglas de registro de entrada",
  "Clock-in location": "Ubicación del registro",
  "Every punch records where it was made. Only company admins can see those locations.":
    "Cada registro guarda dónde se hizo. Solo los administradores de la empresa pueden ver esas ubicaciones.",
  "A 30-minute break that ran 37 comes off the shift as 30, so an overrun is yours to manage rather than theirs to pay for. Timecards still show how far over it went. Switch this off to charge the clock time as it was recorded.":
    "Un descanso de 30 minutos que duró 37 se descuenta del turno como 30, así el exceso lo administras tú y no lo paga el empleado. Las tarjetas de tiempo aún muestran cuánto se pasó. Desactiva esto para descontar el tiempo del reloj tal como se registró.",
  "Coming back early is never rounded up: a 30 taken in 22 counts as 22 and the day is flagged as an incomplete break, whichever way this is set.":
    "Regresar antes nunca se redondea hacia arriba: un descanso de 30 tomado en 22 cuenta como 22 y el día se marca con un descanso incompleto, sin importar cómo esté configurado.",
  "Break reminders": "Recordatorios de descanso",
  "Flags anyone on the dashboard who has been working this long without a break. Taking one clears the flag; a manager can also dismiss it.":
    "Marca en el panel a quien lleve trabajando este tiempo sin descanso. Tomar uno quita la marca; un gerente también puede descartarla.",
  "Scheduling options": "Opciones de horario",
  "Schedule screen": "Pantalla de horario",
  "Which one appears in your menu. Employees always keep their own schedule view.":
    "Cuál aparece en tu menú. Los empleados siempre conservan su propia vista de horario.",
  "What employees see": "Lo que ven los empleados",
  Reset: "Restablecer",
  "Save rules": "Guardar reglas",
  "Overtime after (hours/day)": "Horas extra después de (horas/día)",
  "Double time after (hours/day)": "Pago doble después de (horas/día)",
  "Overtime threshold (hours/week)": "Límite de horas extra (horas/semana)",
  Off: "Desactivado",
  "Pay to the minute, exactly as punched.": "Pagar al minuto, exactamente como se registró.",
  "Nearest 5 minutes": "5 minutos más cercanos",
  "2:23 → 2:25. Quarter-hour marks stay put.":
    "2:23 → 2:25. Las marcas de cuarto de hora se quedan igual.",
  "Nearest 10 minutes": "10 minutos más cercanos",
  "2:23 → 2:20, and 2:26 → 2:30.": "2:23 → 2:20, y 2:26 → 2:30.",
  "Workday start hour (0–23)": "Hora de inicio del día laboral (0–23)",
  "Block off-site punches": "Bloquear registros fuera del lugar",
  "Staff have to be inside the worksite radius to clock in or out.":
    "El personal debe estar dentro del radio del lugar de trabajo para registrar entrada o salida.",
  "Record location only": "Solo guardar la ubicación",
  "Punches go through from anywhere, and you see where each one was made.":
    "Los registros se aceptan desde cualquier lugar y ves dónde se hizo cada uno.",
  "Allow 10-min break (paid)": "Permitir descanso de 10 min (pagado)",
  "Allow 30-min break (unpaid)": "Permitir descanso de 30 min (sin pago)",
  "Allow 60-min break (unpaid)": "Permitir descanso de 60 min (sin pago)",
  "Count breaks as the length that was picked": "Contar los descansos con la duración elegida",
  "Auto clock-out after (hours, 0 = off)": "Salida automática después de (horas, 0 = desactivado)",
  "Remind about a break after (hours, 0 = off)":
    "Recordar un descanso después de (horas, 0 = desactivado)",
  "Remind about lunch after (hours, 0 = off)":
    "Recordar la comida después de (horas, 0 = desactivado)",
  "Schedule builder": "Creador de horarios",
  "Day, week and month grids, with a shift editor behind every cell.":
    "Cuadrículas de día, semana y mes, con un editor de turnos detrás de cada celda.",
  "Monthly schedule sheet": "Hoja mensual de horarios",
  "The posted roster: teams down the page, days across, an X on each working day.":
    "La lista publicada: equipos hacia abajo, días a lo ancho y una X en cada día de trabajo.",
  "Week starts on": "La semana empieza el",
  "Schedule advance notice (hours)": "Aviso previo del horario (horas)",
  "Allow shift trades": "Permitir intercambios de turno",
  "Let employees request to swap shifts with each other.":
    "Permite que los empleados soliciten intercambiar turnos entre ellos.",
  "Allow time-off requests": "Permitir solicitudes de tiempo libre",
  "Let employees submit time-off requests for approval.":
    "Permite que los empleados envíen solicitudes de tiempo libre para aprobación.",
  "Hide admins from the rosters": "Ocultar a los administradores de las listas",
  "Admins drop off the dashboard roster, the schedule grid, the timecard table and the list of people a shift can be traded with — on everyone's screen, including their own. They can still open their own timecard. Leave this off if your admins work shifts like anyone else.":
    "Los administradores desaparecen de la lista del panel, la cuadrícula del horario, la tabla de tarjetas de tiempo y la lista de personas con quienes se puede intercambiar un turno, en la pantalla de todos, incluida la suya. Aún pueden abrir su propia tarjeta de tiempo. Déjalo desactivado si tus administradores trabajan turnos como cualquier otro.",

  // Audit log
  "Audit log": "Registro de auditoría",
  "Every schedule edit, approval, role change, and billing change for {name}. Entries are written by the database itself and cannot be edited or forged from the app.":
    "Cada edición de horario, aprobación, cambio de rol y cambio de facturación de {name}. Los registros los escribe la propia base de datos y no se pueden editar ni falsificar desde la aplicación.",
  Everything: "Todo",
  Shifts: "Turnos",
  Schedules: "Horarios",
  "Time off": "Tiempo libre",
  Trades: "Intercambios",
  Roles: "Roles",
  Billing: "Facturación",
  insert: "alta",
  update: "cambio",
  delete: "baja",
  "Nothing recorded yet.": "Aún no se ha registrado nada.",
  "Unknown user": "Usuario desconocido",
  System: "Sistema",
  Before: "Antes",
  After: "Después",
  "← Newer": "← Más recientes",
  "Page {n}": "Página {n}",
  "Older →": "Más antiguos →",
  none: "ninguno",

  // Worksite
  "Pick a location on the map first.": "Primero elige una ubicación en el mapa.",
  "Failed to save": "No se pudo guardar",
  "No company.": "Sin empresa.",
  "Worksite location": "Ubicación del lugar de trabajo",
  "Click the map to set where employees must be in order to clock in/out. The blue circle shows the allowed area.":
    "Haz clic en el mapa para definir dónde deben estar los empleados para registrar entrada o salida. El círculo azul muestra el área permitida.",
  Worksite: "Lugar de trabajo",
  "Click anywhere on the map to drop the pin. Map data © OpenStreetMap contributors.":
    "Haz clic en cualquier parte del mapa para colocar el marcador. Datos del mapa © colaboradores de OpenStreetMap.",
  Coordinates: "Coordenadas",
  "Allowed radius:": "Radio permitido:",
  "Saving…": "Guardando…",
  "Save worksite": "Guardar lugar de trabajo",
  "Currently saved": "Guardado actualmente",
  Radius: "Radio",
  "No worksite saved yet — drop a pin and click Save.":
    "Aún no hay un lugar de trabajo guardado — coloca un marcador y haz clic en Guardar.",

  // Reports
  Date: "Fecha",
  Start: "Inicio",
  End: "Fin",
  Hours: "Horas",
  Time: "Hora",
  published: "publicado",
  draft: "borrador",
  Published: "Publicado",
  Draft: "Borrador",
  Denied: "Rechazadas",
  "Join or create a company to see reports.": "Únete o crea una empresa para ver los reportes.",
  Reports: "Reportes",
  "Hours, coverage, and time off for {range}.": "Horas, cobertura y tiempo libre de {range}.",
  "This week": "Esta semana",
  "Last week": "La semana pasada",
  "This month": "Este mes",
  "Last 30 days": "Últimos 30 días",
  "Scheduled hours": "Horas programadas",
  "1 shift": "1 turno",
  "{n} shifts": "{n} turnos",
  "Staff with shifts": "Personal con turnos",
  "{n} total": "{n} en total",
  "Time-off days": "Días de tiempo libre",
  "1 request": "1 solicitud",
  "{n} requests": "{n} solicitudes",
  "Uncovered days": "Días sin cobertura",
  "1 draft shift": "1 turno en borrador",
  "{n} draft shifts": "{n} turnos en borrador",
  "Hours per employee": "Horas por empleado",
  "Export CSV": "Exportar CSV",
  "No employees in this company yet.": "Aún no hay empleados en esta empresa.",
  "Over 40h": "Más de 40 h",
  "Coverage by day": "Cobertura por día",
  "No data.": "Sin datos.",
  "No coverage": "Sin cobertura",
  "Time off breakdown": "Desglose de tiempo libre",
  "No time-off requests in this range.": "No hay solicitudes de tiempo libre en este rango.",
  "Approved days": "Días aprobados",
  "By kind": "Por tipo",
  "1 day": "1 día",
  "{n} days": "{n} días",
  "All shifts in range": "Todos los turnos del rango",
  "No shifts scheduled in this range.": "No hay turnos programados en este rango.",
  "Showing 50 of {n}. Export CSV for the full list.":
    "Mostrando 50 de {n}. Exporta el CSV para ver la lista completa.",
};

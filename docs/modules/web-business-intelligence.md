# Interfaz de inteligencia de negocio

**Unificación propuesta (2026-10-31):** [contrato](api-bi-unified.md) y [plan](../plan/2026-10-31_feat-bi-unificado.md) preparan gráficos/desgloses, KPIs/OKRs y la integración de Actividad. Sólo fase 1: la navegación y la pantalla Analítica actuales no se retiran hasta fase 4.

**Analítica estadística (2026-10-19):** fase4 implementada en `?view=statistics` para admin/editor: pronóstico, patrones y anomalías con gráficos/tablas y tres CSV independientes. [Contrato](api-bi-statistics.md#5-interfaz-y-exportación), [plan y evidencia](../plan/2026-10-19_feat-bi-analitica-estadistica.md). Opt-in de API apagado por defecto; aceptación integral local completada en fase5 con API/worker/PG/Redis y navegador reales. [Evidencia y habilitación](../operations/31_bi_statistics_validation_and_rollout.md). Despliegue y utilidad predictiva real pendientes.

**Estado del BI operativo previo:** frontend implementado y aceptación integral local de su fase5 completada; despliegue pendiente. [Evidencia y habilitación](../operations/23_bi_validation_and_release.md). [Plan HITL](../plan/2026-10-09_feat-interfaces-operacion-bi.md), [contratos HTTP](api-bi-operations.md).

## Entrada, roles y navegación

`/admin/business-intelligence` compone la pantalla del feature mediante Suspense. La sesión vigente (`useSession`) proporciona el transporte privado con cookies, recuperación y CSRF; no se introducen credenciales ni almacenamiento de tokens. NestJS autoriza cada consulta y mutación y obtiene el tenant de sesión.

| Vista                 | Admin                                      | Editor         | Contenido                                                                                              |
| --------------------- | ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------ |
| Analítica estadística | Consulta y CSV                             | Consulta y CSV | Pronóstico mensual evaluado, taxonomía/segmentos y señales exploratorias con ventanas propias.         |
| Resumen               | Consulta y CSV                             | Consulta y CSV | Indicadores, vigencia, estados, categorías, gráfico con cortes ausentes y tabla diaria.                |
| Ejecuciones           | Consulta                                   | Consulta       | Solicitudes e intentos paginados de forma independiente, filtros UTC/estado/origen.                    |
| Detalle               | Consulta y acciones permitidas             | Consulta       | Fase, tiempos, cantidades conocidas, resultado y explicación segura; solicitud con intentos asociados. |
| Operación             | Solicitar, reintentar y cancelar pendiente | Consulta       | Señal del worker, programación, presupuesto, actividad y motivos de bloqueo del servidor.              |
| Configuración         | Edición versionada                         | Sólo lectura   | Frecuencia 1/6/24 h, pausa y avisos de fallos/atrasos con tolerancia 30/60/120 min.                    |
| Auditoría             | Consulta                                   | Sin acceso     | Actor técnico, instante, solicitud y configuración anterior/posterior.                                 |

`view`, `from`, `to`, `page`, `requestPage`, `status`, `origin`, `requestStatus`, `run` y `request` viven en URL. Los enlaces conservan filtros y eliminan detalles al cambiar de vista; al entrar en estadísticas se eliminan filtros heredados y sólo queda `view=statistics`. Sus ventanas de24 meses y90 días son explícitas y no toman el rango del resumen. Fechas reales UTC, máximo 366 días hasta hoy; 30 días por defecto. Un enlace inválido se explica sin consultar la API. Listas de 20 filas; paginación validada desde `meta` del envelope, nunca inventada.

## Lecturas y aislamiento

Los adaptadores validan datos con Zod, preservan cantidades decimales y diferencias entre NULL y cero. Sólo se cargan las listas/detalles de la vista seleccionada. El estado operativo se consulta cada 30 s en las vistas válidas salvo estadísticas y cada 5 s si hay actividad de la empresa. Historial activo y detalles pendientes/en ejecución usan 5 s; detalles terminados dejan de consultar periódicamente. Estadísticas, configuración, auditoría y resumen se actualizan al entrar, al volver a la pestaña o mediante «Actualizar vista».

Las lecturas se programan después de terminar la anterior, sin solapamientos. Se abortan al ocultar la pestaña, desmontar o cambiar filtros y se descartan respuestas obsoletas. Al volver se consulta inmediatamente. Errores de validación, permisos, recurso ausente, cuotas y banderas detienen el polling automático; una lectura temporalmente fallida conserva el último resultado con aviso. 400/401/403/404 retiran datos retenidos. No hay caché compartida entre identidades: el workspace se remonta al cambiar usuario, empresa o roles, incluyendo las mutaciones pendientes del navegador.

## Operaciones y configuración

«Actualizar vista» sólo realiza lecturas. «Ejecutar ahora» solicita POST con clave de idempotencia y abre el enlace de seguimiento tras recibir aceptación. El estado de carga se obtiene de GET requests; aceptación nunca se presenta como publicación completada. Las solicitudes sobreviven al cierre de la página en el warehouse, como define el backend.

Un bloqueo síncrono evita dobles envíos. Ante respuesta ambigua se conserva en memoria el mismo cuerpo y clave: «Repetir solicitud con la misma clave» recupera el resultado durable. No hay reenvíos automáticos ni cambio de intención mientras esa respuesta permanece incierta. El backend conserva su idempotencia aunque se cierre la página; el cliente no persiste claves en almacenamiento del navegador. Al desmontar, una respuesta de mutación no navega ni modifica otra sesión.

Las acciones se habilitan con los permisos y motivos del servidor. Un reintento vincula el fallo y observa el estado actual. Sólo se cancela una solicitud pendiente, con transición confirmada por API; no se ofrece interrupción forzada.

El formulario envía `expectedVersion`. Tras conflicto o respuesta incierta conserva los campos y exige consultar la versión vigente. Muestra las preferencias guardadas y ofrece usar esa configuración o conservar los campos editados sobre la nueva versión, manteniendo los valores vigentes de los campos no editados, antes de otro guardado explícito. No copia automáticamente respuestas nuevas encima de una edición de admin. En editor, la vista se renueva cuando cambia la versión consultada.

## CSV y accesibilidad

El resumen genera cuatro archivos independientes desde el resultado visible autorizado: resumen, estados, categorías y serie diaria. Incluyen rango, UTC y corte/publicación; BOM UTF-8, CRLF y celdas entre comillas con escape de comillas internas. Los textos que puedan iniciar una fórmula reciben apóstrofo, incluso tras espacios/control. Las cantidades grandes permanecen cadenas decimales; NULL queda vacío y los cortes ausentes tienen marca `sin_corte`. No se agregaron dependencias.

La UI utiliza los tokens HSL y primitivas existentes; navegación semántica, `aria-current`, formularios etiquetados, fieldsets, avisos accesibles, foco visible y tablas con captions. Tablas densas tienen contenedor con scroll horizontal; navegación y acciones envuelven en móvil. Los errores técnicos se traducen a mensajes seguros, sin mostrar SQL, stack, conexiones o tokens de métricas.

## Evidencia y límites

Pruebas de contratos, UI, permisos, sesión, idempotencia, polling, configuración y CSV en el feature, más regresión web. La revisión móvil/teclado de fase4 usa una API sintética. La fase5 del plan operativo previo agrega un recorrido con navegador, API real del CMS, worker CLI independiente, dos PostgreSQL18.6 y Redis7 descartables: solicitud pendiente, cierre, nueva sesión y resultado correcto. Las pruebas verifican restauración, privilegios y caída OLAP aislada; el benchmark registra costo local de polling. Estas pruebas no certifican capacidad productiva ni auditoría WCAG completa. Los instantes usan UTC y ciclo explícito de24h para distinguir medianoche de mediodía. `BI_OPERATIONS_ENABLED` permanece desactivada por defecto; no se modificó infraestructura ni se aplicaron migraciones persistentes.

## Mejoras de lectura y protección de edición — fase 10

Las siete superficies conservan sus adaptadores y contratos, URL, UTC, CSV, polling visible y protocolo de comandos inciertos. Resumen y Operación hacen explícita la vigencia y ofrecen el siguiente paso. El gráfico muestra cantidad de testimonios y fechas UTC, una escala numérica (abreviada para cantidades grandes, con desplazamiento horizontal para conservar su legibilidad en móvil) y huecos para días sin corte; cero sigue siendo una observación válida. Los valores exactos permanecen en la tabla diaria y en CSV. Antes del primer corte, inventario y rating se muestran como «Sin corte», sin presentar un cero observado.

Solicitudes e intentos se explican por separado: una intención durable puede tener varios intentos y la aceptación no confirma publicación. Los detalles priorizan estado/fase/resultado y recuperación; los identificadores se consultan en detalles técnicos secundarios. Auditoría muestra sólo las preferencias modificadas con valores anteriores y posteriores, conserva versiones y deja actor/ID en una expansión secundaria. Sin configuración previa se informa la ausencia, sin inventar defaults históricos.

Configuración detecta cambios efectivos contra la base de edición y avisa al salir por enlaces del panel/BI, cierre de sesión o Atrás. Cancelar conserva el formulario; descartar permite salir. Recargar/cerrar usa el aviso nativo del navegador. Durante una escritura no se abandona por los controles de navegación; una respuesta incierta mantiene los campos y exige revisar la versión vigente. No se persiste el draft ni se cambian las garantías del servidor. El guard usa una entrada de historial de la misma URL que contiene sólo un marcador booleano; las preferencias permanecen en memoria. Una nueva pestaña no elimina el formulario actual.

Las regiones de tablas tienen contención de ancho, scroll horizontal y acceso con teclado. La revisión de esta fase usa Chromium con viewports emulados, datos y transporte sintéticos; no reemplaza los servicios reales, otros motores, dispositivo físico ni una auditoría completa con lector de pantalla. La evidencia histórica de integración BI corresponde a su propio SHA y entorno; no se transfiere al nuevo código.

## Consumo estadístico de fase4

`getBiStatistics` consulta sólo `/bi/statistics`, sin parámetros. Muestra corte/cálculo, versión, inicios separados de historia general y etiquetas, edad y plazo de vigencia. La proyección se diferencia con rombo frente a la línea histórica y queda oculta por política cuando falta historia, cobertura, mejora o actualidad. Frecuencias incluyen cobertura, truncamiento y denominador original; asociaciones muestran confianza en ambas direcciones. Señales históricas vencidas llevan aviso y no se presentan como alertas actuales.

Tres CSV: pronóstico (histórico, evaluación y métricas), patrones (frecuencias, segmentos, pares y cobertura) y anomalías (90 días × dos métricas). Conservan la misma publicación visible; todos incluyen versión/corte/UTC/estado/motivo. Cero y NULL son distintos; porcentajes se exportan en puntos porcentuales y lift como razón. Sin publicación, durante actualización o tras un error se bloquean descargas.

Los gráficos no conectan huecos; cada uno tiene tabla alternativa. Las tablas densas y gráficos tienen scroll local accesible por teclado; nombres largos envuelven. La vista no consulta el estado operativo ni agrega polling: sólo entrada, retorno de pestaña, botón o reintento. El remount de identidad y los abortos existentes impiden reutilizar respuestas de otra cuenta. Validación de transporte y CSV con fixtures; HTTP y DW con tests propios. La fase 5 añade sesiones reales admin/editor, dos tenants, cierre y reapertura, tres CSV equivalentes a la API y revisión Chrome en escritorio/móvil. La utilidad predictiva real y la aceptación del destino siguen pendientes.

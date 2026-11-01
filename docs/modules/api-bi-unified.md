# BI unificado: contrato de evolución

**Avance 2026-11-01:** fases 1–2 aprobadas; fase 3 implementada y verificada localmente, pendiente de revisión/ACK. Registradas las lecturas analíticas y los recursos KPI/OKR/avances. Schema autorizado y migración aditiva incorporados; aplicada únicamente en PostgreSQL propio descartable. No se aplicó a bases persistentes. La interfaz unificada y retirada de Analítica corresponden a fase 4; aceptación integral del sistema, a fase 5.

Complementa [BI actual](api-business-intelligence.md), [estadística](api-bi-statistics.md), [operación](api-bi-operations.md) y [plan HITL](../plan/2026-10-31_feat-bi-unificado.md). El catálogo de autoridad es `apps/api/src/modules/business-intelligence/contracts/metric-catalog.ts`; validadores y tipos están en el mismo directorio. Fórmulas del catálogo son definiciones semánticas, nunca SQL ejecutable construido desde texto del cliente.

## 1. Superficies y fronteras

- Navegación única: Resumen, Desgloses, KPIs y OKRs, Analítica estadística, Actividad; grupo administrativo con las vistas operativas existentes. Mantener sus enlaces guardados y restricciones por rol.
- `/admin/analytics` redirige a `/admin/business-intelligence?view=activity` en fase 4. El feature antiguo desaparece entonces, no en fase 1.
- Todas las lecturas analíticas y evaluaciones automáticas usan DW. Actividad y gestión de metas son operaciones OLTP explícitas, nunca sustitutos ante caída de DW. No leer textos/autores para gráficos, rankings o evaluación automática.
- Actividad privada conserva autores/extractos operativos existentes; esos datos no se exportan al warehouse ni se incluyen en métricas o logs.
- `BI_ENABLED=false` conserva el comportamiento de los endpoints BI existentes. Los nuevos análisis tampoco abren conexión. Actividad y definiciones/avances OLTP no dependen de la disponibilidad ni del flag de DW; una evaluación automática se representa indisponible. El middleware privado y JWT/RBAC se aplican a todos los controladores nuevos, incluso en errores.
- Entitlements existentes: lecturas históricas conservadas; mutaciones KPI/OKR requieren `business_intelligence` y permiso comercial de escritura mediante el límite transaccional de billing. Actividad conserva la política de consulta de analytics; ninguna integración de ingresos entra en este alcance.

## 2. Tiempo, filtros y catálogo

### Consulta analítica

`from`, `to` son fechas UTC inclusivas, reales, entre año 0001 y 9999. Usar las reglas existentes de `dateRange`: 30 días por defecto, máximo 366, sin fin futuro; sólo `to` completa los 29 días anteriores; sólo `from` termina hoy UTC. Validar nuevamente al resolver fechas y no sólo al parsear formas de datos.

Parámetros repetibles: `categoryId`, `tagId`, `status`, `source`. Hasta 20 categorías y 20 etiquetas, cinco estados y cinco fuentes por solicitud antes de deduplicar. UUID de origen en categorías/etiquetas, no claves DW sintéticas. `none` representa sin categoría/sin etiqueta; puede combinarse con IDs bajo OR. Estados `draft,pending,approved,published,rejected`; fuentes normalizadas `public,public-browser,api,widget,other`, usando la misma clasificación que la extracción. `ratingMin/ratingMax` son enteros 1–5, máximo no menor que mínimo.

OR dentro de cada dimensión, AND entre dimensiones, existencia de cualquiera de las etiquetas. Canonicalizar UUID a minúsculas y ordenar/deduplicar listas. Rechazar propiedades desconocidas, filtros malformados, IDs ajenos al catálogo de la empresa y `tenantId`. Las opciones de filtros deben permitir seleccionar entidades observadas históricamente aunque ya no estén presentes en el CMS; un ID válido pero ausente no se interpreta como «sin filtro».

La fuente afecta sólo engagement. En resumen/desgloses se etiqueta esa excepción; en una meta de inventario/creaciones se rechaza guardar una fuente inefectiva. El resto del alcance guardado es independiente de filtros de pantalla.

### Semántica temporal

1. **Inventario al cierre:** última cabecera `snapshot_at < (to + 1 día UTC)`, del tenant, con desempate estable por run. Se permite un corte previo al inicio del período, identificado con fecha/antigüedad; no se llama inventario creado en el período. Sin cabecera: `NO_CUT`. Cabecera observada vacía: conteos cero, medias/proporciones sin denominador indisponibles. Fechas de cierre históricas no toman el corte actual.
2. **Series de inventario:** última cabecera real de cada día; aplicar filtros a los atributos de ese corte. Días sin corte quedan desconocidos, sin arrastre ni interpolación. No sumar existencias entre cortes.
3. **Engagement:** eventos fechados dentro del período y conservados en la última reconciliación disponible. Metadatos de reconciliación separados del corte de cierre: la tabla diaria no conserva versiones antiguas del total. No afirmar que reproduce lo conocido al cierre histórico.
4. **Cohortes de engagement/creaciones:** cuando haya filtros de inventario, usar miembros/atributos del corte de cierre del período, mediante EXISTS/semijoin para tags. Los eliminados sin pertenencia a ese corte no entran en esa cohorte; sin esos filtros, conservar todos los eventos/creaciones disponibles. Las series de engagement utilizan esa misma cohorte de cierre, no una atribución falsa al momento del evento. Las series de inventario sí describen cada corte diario; explicar la diferencia en ambas tablas.
5. **Creaciones observadas:** identidades de `fact_testimonial_creation` con `created_at` en el período y `first_observed_at` hasta la marca de observación disponible. No representan todas las altas reales; no reconstruir altas borradas entre cargas. Mostrar inicio de observación y `OUTSIDE_COVERAGE` si el período comienza antes de esa cobertura, sin inventar un flujo histórico completo.
6. **Etiquetas:** exigir marcador del corte usado, incluso para `none` y cobertura etiquetada. Sin marcador: `TAGS_NOT_OBSERVED`, nunca inferir vacío. En series diarias, sólo los días realmente observados permiten aplicar filtros de etiquetas. Nombres de dimensiones son los nombres actuales SCD1; no afirmar nombres históricos.

Fuera de cobertura de reconciliación conocida, indicar `OUTSIDE_COVERAGE` en comparación en lugar de representar historia desconocida como 0. Un día sin eventos dentro del alcance observado puede ser cero. No inferir completitud del tracking ni visitantes únicos.

### Métricas y comparación

`bi_metrics_v1` contiene 16 IDs estables: seis cantidades de inventario —total y cinco estados—, `average_rating`, `low_rating_share`, `published_share`, `categorized_share`, `tagged_share`, `observed_creations`, `views`, `clicks`, `plays`, `ctr`.

- Unidades: `count`, `rating`, `percentage`. Proporciones/CTR se expresan en puntos de 0–100, con CTR sin tope de 100. La estadística vigente mantiene sus ratios 0–1; convertir únicamente para presentación, sin cambiar `stats_v1`.
- Cantidades y decimales viajan como strings exactos, sin exponente. Contrato acotado a 28 dígitos enteros y 12 fraccionarios, coherente con `numeric(40,12)`; magnitud superior produce `OUT_OF_RANGE`, no redondeo a Number. Cálculo con BigInt/Decimal; sólo geometría aproximada puede convertir para dibujar.
- Conteos enteros exactos. Ratios/medias y progreso se serializan redondeados a 12 decimales; comparar umbrales y avances antes del redondeo. Frontend y CSV nunca recalculan métricas.
- Comparar período inmediatamente anterior de igual longitud. Cada período elige su propio corte de cierre y cohorte con los mismos filtros. Si el anterior excede el calendario admitido, comparación indisponible, sin invalidar el período actual.
- Cambio absoluto = actual − anterior; para porcentajes son puntos porcentuales. Cambio relativo = 100 × (actual − anterior) / anterior; anterior 0 => `ZERO_DENOMINATOR`, aunque el cambio absoluto pueda conocerse. No sumar ni promediar porcentajes para obtener tasas agregadas.
- `measurement` es `{status:'available',value:string,reason:null}` o `{status:'unavailable',value:null,reason:Reason}`. Razones: `NO_CUT`, `TAGS_NOT_OBSERVED`, `CREATIONS_NOT_OBSERVED`, `OUTSIDE_COVERAGE`, `ZERO_DENOMINATOR`, `WAREHOUSE_UNAVAILABLE`, `STALE_DATA`, `OUT_OF_RANGE`, `FUTURE_PERIOD`. Un error de consulta completa no se disfraza como un dashboard vacío.

`unified-bi.types.ts` fija los datos de respuesta: `BiOverview`, `BiBreakdowns`, `BiActivity`, `BiKpi`, `BiObjective` y sus procedencias. Aplicar validación equivalente en web al implementar sus adaptadores; los tipos no reemplazan validación de HTTP ni permisos.

## 3. API implementada y compatibilidad pendiente

Todas las rutas usan `/api/v1`, envelope existente `{success:true,data}` y, para listas, `data[]`/`meta` del interceptor. Métodos de mutación validan body estricto y query vacía; actor y tenant sólo de sesión. Lecturas 120/min; escrituras de metas 20/min, dentro del mecanismo actual. `Cache-Control: private, no-store` también en errores. UUID de recursos ajenos da 404; rol insuficiente, 403; versión incompatible, 409.

| Ruta BI | Contrato / autorización |
| --- | --- |
| `GET /bi/metric-catalog` | Admin/editor; versión y 16 definiciones públicas, sin SQL ni configuración privada. Sin conexión DW. |
| `GET /bi/filter-options` | Admin/editor; rango solicitado; categorías y tags históricos del tenant con IDs fuente y etiquetas, estados/fuentes fijos, disponibilidad de tags. Búsqueda por `q` de hasta 120 caracteres y paginación de 20; `dimension=category|tag` al paginar una dimensión. |
| `GET /bi/overview` | Admin/editor; consulta analítica común; `bi_overview_v1`, métricas, procedencias, comparación y hasta 366 filas diarias. |
| `GET /bi/breakdowns` | Admin/editor; mismo rango/filtros; `bi_breakdowns_v1`, categorías/tags, estados, rating, fuentes y ranking de 20. Listas categorías/tags hasta 50, `totalGroups` exacto y `truncated`; no inventar «Otros» ni recalcular porcentajes sobre subtotal. |
| `GET /bi/activity` | Admin/editor; fechas, `eventType` y `source` repetibles, `page` de 1–10000; 20 eventos por página. Envelope `data[]` de eventos y `meta:{total,page,limit:20,observedAt,source:'operational',range}`; IDs de eventos como strings decimales. |
| `GET /bi/kpis`, `GET /bi/objectives` | Admin/editor; `page`, estado y responsable opcionales, 20 por página; orden período final DESC/ID DESC. Evaluaciones agrupadas por alcance, sin una conexión/query por tarjeta. |
| `GET /bi/kpis/:id`, `GET /bi/objectives/:id` | Admin/editor; recurso con evaluación/avance, versiones y estado. Objetivo incluye hasta 20 resultados clave. |
| `POST /bi/kpis`, `POST /bi/objectives` | Admin; definición, creación en borrador, 201. Validar responsable activo de la misma empresa, admin/editor. |
| `PATCH /bi/kpis/:id`, `PATCH /bi/objectives/:id` | Admin; `{expectedVersion,definition}` con definición completa, 200. En activo sólo título/descripción/responsable; campos congelados no se pueden alterar. Cerrado/archivado no admite edición. |
| `POST /bi/kpis/:id/transitions`, `POST /bi/objectives/:id/transitions` | Admin; `{expectedVersion,action:'activate'|'close'|'archive'}`, 200. |
| `POST /bi/objectives/:id/key-results` | Admin; `{expectedVersion,definition}` manual/automática en objetivo borrador; versión del objetivo, 201. Incrementa versión del objetivo. |
| `PATCH /bi/objectives/:id/key-results/:resultId` | Admin; `{expectedVersion,expectedObjectiveVersion,definition}` con versión del resultado y del objetivo. En objetivo activo sólo título/responsable; 200. |
| `GET /bi/objectives/:id/key-results/:resultId/progress` | Admin/editor; historial de 20 por página, fecha efectiva DESC/registro DESC/ID DESC. |
| `POST /bi/objectives/:id/key-results/:resultId/progress` | Admin o editor responsable actual del resultado manual; `manualProgressSchema`, 201. Sólo objetivo activo. |

No DELETE: las bajas son archivo. Permitir completar un objetivo borrador sin todos sus resultados; activar exige entre 1 y 20. Corrección de un resultado mal definido: antes de activar, editar; después, cerrar/archivar y crear otro objetivo. No hay desactivación ni reabrir.

Las mutaciones devuelven recibos estables dentro del envelope: crear/editar/transicionar metas `{id,state,version}`; agregar/editar resultado `{id,objectiveId,version,objectiveVersion}`; agregar avance `{id,resultVersion,objectiveVersion}`. Consultar el GET de detalle para obtener evaluación actualizada. Los DTO finales de lectura y cierre se validan con `contracts/governance-response.ts`: KPI incluye `evaluation:{current,progress,rawProgress,evaluatedAt,provenance}`; objetivo incluye `keyResults`, `progress` y `evaluationStatus`. Avance real y avance visual acotado se conservan por separado. Las fechas de calendario son `YYYY-MM-DD` UTC y los instantes, ISO UTC.

POST exige `Idempotency-Key` vigente con el mecanismo OLTP existente: mismo actor/tenant/ruta/contenido recupera respuesta; clave con contenido distinto, 409. PATCH usa CAS; conflicto obliga a releer y revisar, nunca sobrescribir. Auditoría, cambio y recibo idempotente se confirman juntos. Preparar la captura DW y validar pertenencia de filtros precede a la transacción de escritura; un replay completado devuelve el recibo guardado sin repetir esa preparación. Las claves duran 24 horas conforme al mecanismo existente. Crear/editar un alcance con UUID de categoría/tag exige validarlo contra dimensiones históricas de la empresa en DW; sin ese dato disponible se rechaza el nuevo alcance, sin sustituirlo por consultas analíticas OLTP. Una definición sin UUID de dimensiones, un avance manual y un replay completado no requieren esa validación DW. El detalle de errores no incluye datos de driver, SQL ni payloads.

**Pendiente de fase 4:** `GET /analytics/dashboard` conservará su forma acumulada y tope de 50 mediante el servicio de actividad compartido. Sus números antiguos conservan límites seguros; no redondear IDs grandes. `/bi/dashboard` conserva su semántica de último corte global y rango sólo en series/engagement, delegando al motor común con ese modo explícito. Ninguna nueva pantalla consumirá esos adaptadores. Tracking público y `/analytics/testimonials/:id` permanecen.

## 4. Objetivos, progreso y persistencia

### Entidades y reglas

Cuatro tablas OLTP: `bi_kpi_goals`, `bi_objectives`, `bi_key_results`, `bi_progress_entries`. `AuditLog` e idempotencia existentes se reutilizan; no se crea otro sistema de auditoría. UUID públicos, claves y FK compuestas por empresa; `date` para períodos y `timestamptz(3)` para hechos absolutos. Definiciones financieras y monedas quedan fuera.

- KPI: título, responsable, período 1–366 días —futuro admitido—, catálogo/métrica, filtros canónicos, base y meta exactas. No defaults de metas ni consulta que asuma «0 inicial».
- Objetivo: título, descripción, responsable, período. Un atajo web fija las fechas del trimestre UTC actual, sin sustituir fechas guardadas.
- Resultado automático: catálogo/métrica, filtros, base/meta; comparte evaluador con KPI. No acepta avances manuales. Período heredado del objetivo.
- Resultado manual: unidad `count|percentage|number`, base/meta, responsable. Sin catálogo, métrica ni filtros. `count` entero no negativo; `percentage` no negativo; `number` admite negativos. Porcentajes manuales no tienen tope inventado de 100.
- Avance: valor exacto, fecha efectiva, comentario obligatorio —hasta 2000 caracteres— y actor/instante de registro del servidor. Fecha dentro del período y no futura; correcciones se añaden, no actualizan ni borran. Valor vigente = última fecha efectiva hasta evaluación, luego registro DESC/ID DESC; una entrada retroactiva no pisa una fecha efectiva posterior. Sin entradas, valor actual es la base explícita mientras el objetivo está activo, no un cero implícito.
- Estados: `draft→active→closed`; `draft|active|closed→archived`. Activar fija base/meta/alcance/fechas y composición de resultados. Responsable/título pueden cambiar estando activo mediante admin y auditoría. Archivo conserva los datos; no se reabre ni se borra.
- Al pasar la fecha final no cerrar automáticamente: derivar indicador «vencido». Aceptar entradas tardías sólo mientras siga activo y con fecha efectiva válida en período. Un responsable inactivo no se reasigna implícitamente: admin debe corregir la asignación; el actor autenticado debe conservar rol y actividad.

### Evaluación y cierre

Progreso exacto `100 × (actual−base)/(meta−base)`, base distinta de meta. Valor real y progreso sin limitar disponibles; visualización entre 0 y 100. Un objetivo promedia por igual todos sus resultados; cualquiera indisponible => progreso agregado NULL. Sin resultados o período todavía no iniciado, no declarar cumplimiento. Un valor base manual explícito no prueba actividad, sólo el inicio acordado.

Evaluaciones automáticas usan el período guardado hasta min(hoy UTC, fecha final). Inventario se observa al cierre efectivo y eventos/creaciones dentro de ese rango. En objetivo histórico evaluar antigüedad respecto al cierre efectivo, no exigir una carga posterior a la fecha final. Corte que supera frecuencia+tolerancia al cierre efectivo => `STALE_DATA`, manteniendo procedencia. Incapacidad del DW no borra definiciones/avances ni impide consulta de la gestión OLTP.

Cierre explícito conserva JSON validado: catálogo, definiciones/alcances usados, mediciones, avance, procedencias y hora de evaluación. Permitir cerrar sin datos dejando indisponibilidad explícita; no convertirla en cumplimiento. Una publicación posterior no modifica un cierre. El cálculo DW se hace fuera de transacción OLTP; al escribir cierre se verifica la versión del objetivo/KPI y resultados, con locks ordenados objetivo→resultados por ID. Un avance o edición concurrente invalida el cierre con 409. No usar transacciones distribuidas ni conexiones de red dentro de tx OLTP.

Cada avance comprueba asignación, estado y versiones dentro de la misma transacción, bloquea objetivo→resultado e incrementa versiones de ambos junto con entrada/auditoría/idempotencia. Crear/editar un resultado también incrementa la versión del padre. Padres y valores manuales se vuelven a leer si cambia la versión durante una evaluación.

### Persistencia incorporada y separación de permisos

Los [borradores SQL](../plan/2026-10-31_feat-bi-unificado_oltp-draft.sql) y [Prisma](../plan/2026-10-31_feat-bi-unificado_schema.prisma) conservan el diseño revisado. Tras ACK explícito, las cuatro entidades y relaciones inversas están en el schema canónico y la migración aditiva `20261101000000_bi_governance`. No se modificaron migraciones anteriores. Despliegue persistente y concesión efectiva de permisos runtime siguen pendientes de autorización y aceptación integral; el arranque HTTP no ejecuta DDL ni consultas a estas tablas.

El SQL incluye checks, índices de FK, FK de avances exclusivamente a resultado manual y trigger append-only. Reglas que requieren usuario/estado del padre se verifican transaccionalmente en el repositorio de gestión; DDL no acredita RBAC. Ninguna identidad runtime recibe DDL. Runtime OLTP recibe SELECT/INSERT/UPDATE sólo en las tres tablas mutables, SELECT/INSERT en avances; extractor, lector DW, worker y control BI no reciben permisos sobre estos datos. No exportar textos libres, responsables o avances.

## 5. Datos base, interfaz y aceptación pendiente

Se separó en fase 2 el preflight/captura/publicación de taxonomía y primeras observaciones de la ejecución de jobs `stats_v1`. Reutilizar los objetos existentes de 0005 y la inicialización histórica manual; no duplicarlos. Datos base dependen de BI/entitlement `business_intelligence`; sólo jobs/publicación estadística dependen también de `BI_STATISTICS_ENABLED` y `bi_statistics`. Sin objetos/privilegios compatibles, conservar el flujo base antiguo y anunciar capacidades incompletas, sin inventar etiquetas. Una extracción base avanzada iniciada como completa no publica parcialmente. No crear marcadores de etiquetas para cortes pasados.

No se propone DDL DW nuevo para estas capacidades en fase 1: 0001–0005 ya contienen sus datos. Índices adicionales se decidirán por EXPLAIN/benchmark en fase 2 y requerirán una migración nueva, nunca editar las anteriores. No añadir dependencias, infraestructura ni cron alternativo.

Web: filtros explícitos y compartidos entre Resumen/Desgloses, chips y restablecer; cambios de dimensión no alteran ventanas de estadística o alcances de objetivos. Conservar gráficos estadísticos, tablas y CSV actuales. Nuevas gráficas Recharts con alternativa tabular, labels/unidades y teclado; barras de categorías/tags activan filtros. Máximos de ranking 20, listas de desgloses 50 y todos los límites visibles. CSV sólo respuesta autorizada visible, incluyendo rango/alcance/procedencia/truncamiento; neutralización de fórmulas igual que exportación actual. No incluir otros datos ocultos para exportar.

Verificación local de fase 3: 184 casos en 19 suites de API/lógica/regresión, 14 casos OLTP y 13 DW contra PostgreSQL 18.6 propios descartables. Tipos y ESLint afectados aprobados. HTTP prueba JWT, RBAC, CSRF, cuotas, respuestas privadas y contratos; credenciales y almacén de cuotas están simulados. OLTP ejecuta persistencia, auditoría, CAS, idempotencia y actividad reales con padres sintéticos y permiso comercial simulado. Esto no acredita el recorrido con AuthService/billing/Redis reales ni despliegue o capacidad productiva. La matriz integral, UI/CSV y navegador continúan pendientes en fases 4–5. [Evidencia y reproducción](../plan/2026-10-31_feat-bi-unificado.md).

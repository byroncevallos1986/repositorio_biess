const { chromium } = require("playwright");
const { BigQuery } = require("@google-cloud/bigquery");

// ==================================================
// CONFIGURACIÓN GENERAL
// ==================================================

const URL_MONITOREO = "https://pq.biess.fin.ec/";
const TIMEOUT_MS = 30000;
const ZONA_HORARIA_ECUADOR = "America/Guayaquil";

// BigQuery
const BIGQUERY_PROJECT_ID = process.env.BIGQUERY_PROJECT_ID || "rumdb-499414";
const BIGQUERY_DATASET_ID = process.env.BIGQUERY_DATASET_ID || "rumds";

// IMPORTANTE:
// Se cambia la tabla destino de tb_monitor a tb_monitor_particionada.
// Esta tabla debe estar creada previamente en BigQuery y particionada por Fecha_hora.
const BIGQUERY_TABLE_ID =
  process.env.BIGQUERY_TABLE_ID || "tb_monitor_particionada";

// ==================================================
// FUNCIONES DE FECHA Y TEXTO
// ==================================================

function obtenerFechaHoraEcuador(fecha = new Date()) {
  const partes = new Intl.DateTimeFormat("sv-SE", {
    timeZone: ZONA_HORARIA_ECUADOR,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(fecha);

  const valores = {};

  for (const parte of partes) {
    valores[parte.type] = parte.value;
  }

  // Formato correcto para BigQuery cuando el campo Fecha_hora es DATETIME.
  // No se envía UTC ni zona horaria, porque DATETIME representa fecha/hora local.
  return `${valores.year}-${valores.month}-${valores.day} ${valores.hour}:${valores.minute}:${valores.second}`;
}

function recortarTexto(texto, maximo = 1000) {
  if (!texto) {
    return "";
  }

  if (texto.length > maximo) {
    return texto.substring(0, maximo);
  }

  return texto;
}

// ==================================================
// VALIDAR PÁGINA WEB CON PLAYWRIGHT
// ==================================================

async function validarPagina() {
  let browser;
  let inicioValidacion = Date.now();

  const fechaRegistro = new Date();

  const resultado = {
    Fecha_hora: obtenerFechaHoraEcuador(fechaRegistro),
    Estado: "No Disponible",
    Codigo_http: null,
    Tiempo_respuesta_ms: 0,
    Mensaje: "",
    Url: URL_MONITOREO,
    Titulo: "",
    Error_detalle: ""
  };

  try {
    browser = await chromium.launch({
      headless: true
    });

    const context = await browser.newContext({
      ignoreHTTPSErrors: false,
      viewport: {
        width: 1366,
        height: 768
      }
    });

    const page = await context.newPage();

    inicioValidacion = Date.now();

    const response = await page.goto(URL_MONITOREO, {
      waitUntil: "load",
      timeout: TIMEOUT_MS
    });

    await page.locator("body").waitFor({
      state: "visible",
      timeout: 10000
    });

    const tiempoRespuesta = Date.now() - inicioValidacion;
    const codigoHttp = response ? response.status() : null;

    const titulo = await page.title().catch(() => "");

    const textoBody = await page
      .locator("body")
      .innerText({
        timeout: 5000
      })
      .catch(() => "");

    const httpOk =
      codigoHttp !== null &&
      codigoHttp >= 200 &&
      codigoHttp < 400;

    const contenidoOk = textoBody.trim().length > 0;

    resultado.Tiempo_respuesta_ms = Math.round(tiempoRespuesta);
    resultado.Codigo_http = codigoHttp;
    resultado.Titulo = recortarTexto(titulo, 200);

    if (httpOk && contenidoOk) {
      resultado.Estado = "Disponible";
      resultado.Mensaje = "Despliegue de página exitoso";
      resultado.Error_detalle = "";
    } else {
      resultado.Estado = "No Disponible";
      resultado.Mensaje = "La página respondió, pero no cumplió la validación esperada";
      resultado.Error_detalle = `HTTP=${codigoHttp}, contenidoOk=${contenidoOk}`;
    }
  } catch (error) {
    resultado.Estado = "No Disponible";
    resultado.Tiempo_respuesta_ms = Math.round(Date.now() - inicioValidacion);
    resultado.Mensaje = "Error al validar el despliegue de la página";
    resultado.Error_detalle = recortarTexto(error.message, 1000);
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  return resultado;
}

// ==================================================
// GUARDAR RESULTADO EN BIGQUERY
// ==================================================

async function guardarEnBigQuery(resultado) {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error(
      "No existe la variable GOOGLE_APPLICATION_CREDENTIALS. Verificar el Secret GCP_SERVICE_ACCOUNT en GitHub Actions."
    );
  }

  const bigquery = new BigQuery({
    projectId: BIGQUERY_PROJECT_ID
  });

  // La tabla tb_monitor_particionada debe tener el siguiente esquema:
  // Fecha_hora          DATETIME
  // Estado              STRING
  // Codigo_http         INTEGER / INT64
  // Tiempo_respuesta_ms INTEGER / INT64
  const fila = {
    Fecha_hora: resultado.Fecha_hora,
    Estado: resultado.Estado,
    Codigo_http: resultado.Codigo_http,
    Tiempo_respuesta_ms: resultado.Tiempo_respuesta_ms
  };

  await bigquery
    .dataset(BIGQUERY_DATASET_ID)
    .table(BIGQUERY_TABLE_ID)
    .insert([fila]);

  console.log("Registro almacenado correctamente en BigQuery");
  console.log(`Proyecto: ${BIGQUERY_PROJECT_ID}`);
  console.log(`Dataset: ${BIGQUERY_DATASET_ID}`);
  console.log(`Tabla: ${BIGQUERY_TABLE_ID}`);
  console.log(`Fecha hora Ecuador: ${resultado.Fecha_hora}`);
  console.log(`Estado: ${resultado.Estado}`);
  console.log(`Código HTTP: ${resultado.Codigo_http}`);
  console.log(`Tiempo respuesta ms: ${resultado.Tiempo_respuesta_ms}`);
  console.log(`Mensaje: ${resultado.Mensaje}`);

  if (resultado.Error_detalle) {
    console.log(`Detalle error: ${resultado.Error_detalle}`);
  }
}

// ==================================================
// PROCESO PRINCIPAL
// ==================================================

async function main() {
  const resultado = await validarPagina();
  await guardarEnBigQuery(resultado);
}

main().catch((error) => {
  console.error("Error general del monitoreo:");
  console.error(error);

  if (error && error.name === "PartialFailureError" && error.errors) {
    console.error("Detalle de errores BigQuery:");
    console.error(JSON.stringify(error.errors, null, 2));
  }

  process.exit(1);
});

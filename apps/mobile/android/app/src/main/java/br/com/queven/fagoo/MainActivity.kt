package br.com.queven.fagoo

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import br.com.queven.fagoo.core.*
import br.com.queven.fagoo.core.net.ApiClient
import br.com.queven.fagoo.core.push.PushRegistrar
import br.com.queven.fagoo.panel.PanelScreen
import br.com.queven.fagoo.panel.PanelPrinterSettings
import br.com.queven.fagoo.ui.conversations.ConversationScreen
import br.com.queven.fagoo.ui.conversations.ConversationsScreen
import br.com.queven.fagoo.ui.team.TeamScreen
import br.com.queven.fagoo.ui.theme.FagooTheme
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import java.util.UUID

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        setContent { FagooTheme {
            val container = FagooApp.instance.containerOrNull
            if(container == null) Text("O armazenamento seguro está indisponível. Reinicie o aparelho para entrar no Fagoo.", Modifier.padding(24.dp))
            else FagooShell(container)
        } }
    }
}

@Composable private fun FagooShell(c: AppContainer) {
    val auth by c.auth.collectAsState()
    var exit by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var validating by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(auth.mode, lifecycle) {
        if(auth.mode == "human") lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while(true) {
                validating = !c.verified
                try { c.validateOnline(); error = null; PushRegistrar.registerIfNeeded(c) }
                catch(e: CancellationException) { throw e }
                catch(e: Exception) { error = ApiClient.describe(e) }
                finally { validating = false }
                delay(30_000)
            }
        }
    }
    when {
        auth.mode == "panel" && !exit -> PanelScreen(c.session.serverUrl ?: "", c.session.panelToken ?: "", onExit = { exit = true })
        auth.mode == "panel" && exit -> LoginForm(c.session.webUrl.orEmpty(), fixedServer = true, title = "Autorizar saída do painel", onCancel = { exit = false }) { login ->
            val result = FagooAuth.json("${login.discovery.api_url}/v1/fagoo/device/exit", "POST", buildJsonObject { put("device_id", c.session.panelDeviceId) }, token = login.credentials.text("access_token"), mobile = true)
            check(result["allowed"]?.jsonPrimitive?.booleanOrNull == true) { "Saída não autorizada" }
            c.accept(login); exit = false
        }
        auth.isLoggedIn -> key(auth.generation) {
            val store=remember { ViewModelStore() }
            val owner=remember { object:ViewModelStoreOwner { override val viewModelStore=store } }
            DisposableEffect(store) { onDispose { store.clear() } }
            CompositionLocalProvider(LocalViewModelStoreOwner provides owner) { HumanHome(c) }
        }
        auth.mode == "human" -> Column(Modifier.padding(24.dp), verticalArrangement=Arrangement.spacedBy(12.dp)) {
            Text("Validando sessão online", style=MaterialTheme.typography.headlineSmall)
            if(validating) CircularProgressIndicator()
            error?.let { Text(it) }
            Button(onClick={scope.launch { validating=true; try { c.validateOnline(); error=null } catch(e:Exception) { error=ApiClient.describe(e) } finally { validating=false } }},enabled=!validating) { Text("Tentar novamente") }
            TextButton(onClick={c.onLoggedOut(true)}) { Text("Limpar sessão local") }
        }
        else -> LoginForm(c.session.webUrl.orEmpty(), onLogin = { c.accept(it) })
    }
}

@Composable private fun LoginForm(initialServer: String, fixedServer: Boolean = false, title: String = "Entrar no Fagoo", onCancel: (() -> Unit)? = null, onLogin: suspend (FagooLogin) -> Unit) {
    var server by remember { mutableStateOf(initialServer) }
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    var mfa by remember { mutableStateOf<MfaRequired?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    BackHandler(onCancel != null && !busy) { onCancel?.invoke() }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement=Arrangement.spacedBy(14.dp)) {
        Text(title, style=MaterialTheme.typography.headlineMedium)
        Text("Use o endereço e a conta da sua instalação. Este aplicativo precisa de conexão com a internet.")
        OutlinedTextField(server,{server=it},label={Text("Endereço do Fagoo")},singleLine=true,enabled=!fixedServer && !busy && mfa==null)
        if(mfa==null) {
            OutlinedTextField(email,{email=it},label={Text("E-mail")},singleLine=true,enabled=!busy)
            OutlinedTextField(password,{password=it},label={Text("Senha")},visualTransformation=PasswordVisualTransformation(),singleLine=true,enabled=!busy)
        } else OutlinedTextField(code,{code=it.filter(Char::isDigit).take(6)},label={Text("Código do autenticador")},singleLine=true,enabled=!busy)
        error?.let { Text(it,color=MaterialTheme.colorScheme.error) }
        Button(enabled=!busy && (mfa!=null || (server.isNotBlank() && email.isNotBlank() && password.isNotEmpty())),onClick={scope.launch {
            busy=true; error=null
            try {
                val login=mfa?.let { FagooAuth.verify(it,code) } ?: FagooAuth.login(server,email,password)
                password=""; code=""; mfa=null
                onLogin(login)
            } catch(e:MfaRequired) { password=""; mfa=e; error=e.message }
            catch(e:CancellationException) { throw e }
            catch(e:Exception) { error=ApiClient.describe(e) }
            finally { busy=false }
        }}) { Text(if(busy) "Validando…" else if(mfa!=null) "Confirmar código" else "Entrar") }
        if(onCancel!=null) TextButton(enabled=!busy,onClick=onCancel) { Text("Voltar ao painel") }
        if(mfa!=null) TextButton(enabled=!busy,onClick={mfa=null;code=""}) { Text("Usar outra conta") }
    }
}

@Composable private fun HumanHome(c: AppContainer) {
    var page by remember { mutableStateOf("home") }
    var selected by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope=rememberCoroutineScope()
    val permission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { PushRegistrar.registerIfNeeded(c,true) }
    LaunchedEffect(Unit) { if(android.os.Build.VERSION.SDK_INT>=33) permission.launch(android.Manifest.permission.POST_NOTIFICATIONS) }
    BackHandler(page!="home" || selected!=null) { if(selected!=null) selected=null else page="home" }
    when {
        selected!=null -> ConversationScreen(c,selected!!,onBack={selected=null})
        page=="team" -> TeamScreen(c,onBack={page="home"})
        page=="panel" -> PanelEnrollment(c,onBack={page="home"})
        page=="printer" -> PanelPrinterSettings(onBack={page="home"})
        else -> Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(12.dp),horizontalArrangement=Arrangement.SpaceBetween) {
                Text("Fagoo", style=MaterialTheme.typography.titleLarge)
                TextButton(enabled=!busy,onClick={scope.launch { busy=true;try { PushRegistrar.unregister(c);c.onLoggedOut(true) }catch(e:Exception){error=ApiClient.describe(e)}finally{busy=false} }}) { Text("Sair") }
            }
            val ctx=c.context
            val current=ctx?.units?.find { it.id==c.session.profileId }
            var expanded by remember { mutableStateOf(false) }
            Box(Modifier.padding(horizontal=12.dp)) {
                TextButton(onClick={expanded=true}) { Text(current?.name ?: "Escolher unidade") }
                DropdownMenu(expanded,{expanded=false}) { ctx?.units?.forEach { unit -> DropdownMenuItem(text={Text(unit.name)},onClick={expanded=false;scope.launch { try { PushRegistrar.unregister(c);c.onProfileSelected(unit.id) }catch(e:Exception){error=ApiClient.describe(e)} }}) } }
            }
            Row(Modifier.padding(horizontal=12.dp)) {
                if(current?.capabilities?.contains("team.chat")==true) TextButton(onClick={page="team"}) { Text("Pessoas e bots") }
                if(ctx?.role=="admin") TextButton(onClick={page="panel"}) { Text("Usar como painel") }
                if(ctx?.role=="admin") TextButton(onClick={scope.launch { try { c.validateOnline(); page="printer" } catch(e:Exception) { error=ApiClient.describe(e) } }}) { Text("Impressora") }
            }
            error?.let { Text(it,Modifier.padding(12.dp),color=MaterialTheme.colorScheme.error) }
            if(current?.capabilities?.contains("communication.read")==true) ConversationsScreen(c,Modifier.weight(1f),openConversation={selected=it})
            else Text("Escolha uma unidade para abrir os recursos autorizados.",Modifier.padding(24.dp))
        }
    }
}

@Composable private fun PanelEnrollment(c: AppContainer,onBack:()->Unit) {
    var devices by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var selected by remember { mutableStateOf<JsonObject?>(null) }
    val scope=rememberCoroutineScope()
    LaunchedEffect(Unit) {
        try { devices=FagooAuth.json("${c.session.serverUrl}/v1/fagoo/setup",token=c.session.token,mobile=true)["devices"]?.jsonArray?.map { it.jsonObject }?.filter { it["active"]?.jsonPrimitive?.booleanOrNull==true && "panel.read" in (it["capabilities"]?.jsonArray?.map { v->v.jsonPrimitive.content } ?: emptyList()) } ?: emptyList() }
        catch(e:Exception){error=ApiClient.describe(e)}
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
        Text("Usar este aparelho como painel",style=MaterialTheme.typography.headlineSmall)
        Text("Escolha o aparelho cadastrado no Fagoo web. A sessão pessoal será encerrada. Uma conta autorizada será exigida para sair do painel.")
        devices.forEach { d -> OutlinedButton(enabled=!busy,onClick={selected=d}) { Text(d.text("name") ?: "Painel") } }
        if(devices.isEmpty()) Text("Cadastre um aparelho com permissão de painel em Configurar no Fagoo web.")
        error?.let{Text(it,color=MaterialTheme.colorScheme.error)}
        TextButton(enabled=!busy,onClick=onBack){Text("Voltar")}
    }
    selected?.let { d -> AlertDialog(onDismissRequest={if(!busy)selected=null},title={Text("Ativar ${d.text("name") ?: "painel"}?")},text={Text("A credencial anterior deste aparelho será revogada. Notificações pessoais serão removidas deste celular.")},confirmButton={Button(enabled=!busy,onClick={scope.launch {
        busy=true
        try {
            PushRegistrar.unregister(c)
            val result=FagooAuth.json("${c.session.serverUrl}/v1/fagoo/commands","POST",buildJsonObject { put("command_id",UUID.randomUUID().toString());put("action","device.issue");putJsonObject("payload"){put("id",d.text("id"))} },token=c.session.token,mobile=true)
            val token=result.text("token") ?: error("Credencial não recebida. Verifique o aparelho na web e ative novamente para rotacionar.")
            c.enterPanel(d.text("id") ?: error("Aparelho inválido"),token)
        }catch(e:Exception){error=ApiClient.describe(e);selected=null}finally{busy=false}
    }}){Text(if(busy)"Ativando…" else "Ativar painel")}},dismissButton={TextButton(enabled=!busy,onClick={selected=null}){Text("Cancelar")}}) }
}

-- Integration credentials remain encrypted and accessible only by the ERP service.
CREATE TABLE public.erp_wabotia_pairing (
 id integer PRIMARY KEY CHECK(id=1),
 cipher text NOT NULL DEFAULT '',
 lock_id uuid,
 lock_until timestamptz NOT NULL DEFAULT '-infinity'
);
INSERT INTO public.erp_wabotia_pairing(id) VALUES(1);
ALTER TABLE public.erp_wabotia_pairing ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_wabotia_pairing FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.erp_wabotia_pairing TO service_role;

CREATE FUNCTION public.erp_wabotia_state(p_action text,p_lock uuid DEFAULT NULL,p_cipher text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE current_value text;
BEGIN
 IF p_action='read' THEN
  SELECT cipher INTO current_value FROM public.erp_wabotia_pairing WHERE id=1;
  RETURN jsonb_build_object('cipher',current_value);
 ELSIF p_action='reserve' AND p_lock IS NOT NULL THEN
  UPDATE public.erp_wabotia_pairing SET lock_id=p_lock,lock_until=clock_timestamp()+interval '30 seconds' WHERE id=1 AND lock_until<clock_timestamp() RETURNING cipher INTO current_value;
  RETURN jsonb_build_object('acquired',FOUND,'cipher',current_value);
 ELSIF p_action='save' THEN
  UPDATE public.erp_wabotia_pairing SET cipher=p_cipher WHERE id=1 AND lock_id=p_lock AND lock_until>clock_timestamp();
  IF NOT FOUND THEN RAISE EXCEPTION 'pairing lock expired'; END IF;
 ELSIF p_action='release' THEN
  UPDATE public.erp_wabotia_pairing SET lock_id=NULL,lock_until='-infinity' WHERE id=1 AND lock_id=p_lock;
 ELSE RAISE EXCEPTION 'invalid pairing operation';
 END IF;
 RETURN jsonb_build_object('ok',true);
END $$;
REVOKE ALL ON FUNCTION public.erp_wabotia_state(text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.erp_wabotia_state(text,uuid,text) TO service_role;

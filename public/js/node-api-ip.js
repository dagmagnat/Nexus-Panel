(function () {
  document.querySelectorAll('[data-api-ip-from-endpoint]').forEach(function(button) {
    button.addEventListener('click',function() {
      var form=button.closest('form'), source=form && form.querySelector('[name=subscription_endpoint]'), target=form && form.querySelector('[name=api_connect_ip]');
      if (!source || !target) return;
      var value=source.value.trim(), match=value.match(/^(?:\[([^\]]+)\]|(\d+\.\d+\.\d+\.\d+)):\d+$/);
      if (!match) { alert('В Endpoint должен быть IPv4:порт или [IPv6]:порт. Для доменного Endpoint укажите IP для API вручную.');return; }
      target.value=match[1] || match[2];target.dispatchEvent(new Event('input',{bubbles:true}));target.focus();
    });
  });
})();

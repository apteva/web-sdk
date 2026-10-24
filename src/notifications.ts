/** Notification content and routing are declared by the originating app. */
export interface NotificationChannels { in_app:boolean; tab:boolean; desktop:boolean; mobile:boolean }
export interface NotificationPreviewPreferences { mobile_preview:"hidden"|"content" }
export interface NotificationSubscription {
  install_id:number; project_id:string; type:string; key:string;
  filters:Record<string,string>; channels:NotificationChannels;
}
export interface NotificationDefinition {
  id:string; name:string; description?:string; audience:"project"|"recipients";
  recipients_field?:string; title:string; body?:string; link?:string; group_by?:string;
  defaults:NotificationChannels;
  filters?:{field:string;label:string;options?:{value:string;label:string}[]}[];
}
export interface NotificationSource {
  install_id:number;app:string;name:string;icon:string;icon_style?:"image"|"monochrome";
  topic:string;definition:NotificationDefinition;subscription:NotificationSubscription;follows:NotificationSubscription[];
}
export interface UserNotification {
  id:number;install_id:number;project_id:string;type:string;app:string;app_name:string;
  title:string;body:string;url:string;group:string;created_at:string;read:boolean;channels:NotificationChannels;
}
export interface NotificationSnapshot { items:UserNotification[]; unread_count:number; tab_count:number; next_before:number }
